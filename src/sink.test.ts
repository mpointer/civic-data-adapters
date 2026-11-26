import { describe, it, expect, vi } from "vitest";
import { saveRecords, checkSinkContract, CivicSinkError } from "./sink.js";
import { createRun } from "./outcome.js";
import { runAdapter } from "./registry.js";
import { MemorySink } from "./types.js";
import type { AdapterContext, CivicEvent, CivicRecord, CivicRecordSink, SaveResult } from "./types.js";

const rec = (i: number | string, over: Partial<CivicRecord> = {}): CivicRecord => ({
  provider: "socrata",
  type: "police_blotter",
  title: `Incident ${i}`,
  date: "2026-03-01",
  dedupeKey: `k:${i}`,
  localityName: "Exampleville",
  sourceId: 1,
  ...over,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => rec(i));

/** A sink that records each batch it is given. */
function spySink(reply: (batch: CivicRecord[], call: number) => SaveResult | Promise<SaveResult> = (b) => ({ inserted: b.length, skipped: 0 })) {
  const batches: CivicRecord[][] = [];
  const sink: CivicRecordSink = {
    save: async (b) => {
      batches.push(b);
      return reply(b, batches.length);
    },
  };
  return { sink, batches };
}

function setup(sink: CivicRecordSink, extra: Partial<AdapterContext> = {}) {
  const events: CivicEvent[] = [];
  const ctx: AdapterContext = { sink, onEvent: (e) => void events.push(e), ...extra };
  return { ctx, events, run: createRun(ctx, "[T] sink:") };
}

describe("saveRecords: batching", () => {
  it("hands the sink batches of 500 by default, in order, and sums the results", async () => {
    const s = spySink();
    const { ctx, run } = setup(s.sink);
    const out = await saveRecords(ctx, run, many(1200));
    expect(s.batches.map((b) => b.length)).toEqual([500, 500, 200]);
    expect(s.batches[0]?.[0]?.dedupeKey).toBe("k:0");
    expect(s.batches[2]?.[199]?.dedupeKey).toBe("k:1199");
    expect(out).toMatchObject({ inserted: 1200, skipped: 0 });
  });

  it("honors ctx.sinkBatchSize and ignores nonsense or absurd values", async () => {
    for (const [size, expected] of [[100, [100, 100, 50]], [0, [250]], [-5, [250]], [Number.NaN, [250]], [1e9, [250]]] as const) {
      const s = spySink();
      await saveRecords(setup(s.sink, { sinkBatchSize: size }).ctx, setup(s.sink).run, many(250));
      expect(s.batches.map((b) => b.length), `size ${size}`).toEqual(expected);
    }
  });

  it("does not call the sink at all for nothing to save", async () => {
    const s = spySink();
    const { ctx, run } = setup(s.sink);
    expect(await saveRecords(ctx, run, [])).toMatchObject({ inserted: 0, skipped: 0 });
    expect(s.batches).toHaveLength(0);
  });

  it("emits one sink.save event per batch, with counts and no record contents", async () => {
    const s = spySink();
    const { ctx, run, events } = setup(s.sink, { sinkBatchSize: 2 });
    await saveRecords(ctx, run, many(5));
    const saves = events.filter((e): e is Extract<CivicEvent, { type: "sink.save" }> => e.type === "sink.save");
    expect(saves.map((e) => [e.batch, e.batches, e.records, e.inserted])).toEqual([[1, 3, 2, 2], [2, 3, 2, 2], [3, 3, 1, 1]]);
    expect(JSON.stringify(saves)).not.toContain("Incident");
  });

  it("passes through an upsert sink's `updated` count", async () => {
    const s = spySink((b) => ({ inserted: 1, skipped: 0, updated: b.length - 1 }));
    const { ctx, run } = setup(s.sink, { sinkBatchSize: 3 });
    expect(await saveRecords(ctx, run, many(6))).toMatchObject({ inserted: 2, skipped: 0, updated: 4 });
  });
});

describe("saveRecords: what the sink is protected from", () => {
  it("keeps the first of two records with one dedupeKey and counts the other as skipped", async () => {
    const s = spySink();
    const { ctx, run, events } = setup(s.sink);
    const out = await saveRecords(ctx, run, [rec(1, { title: "first" }), rec(2), rec(1, { title: "second" })]);
    expect(s.batches[0]?.map((r) => r.title)).toEqual(["first", "Incident 2"]);
    expect(out).toMatchObject({ inserted: 2, skipped: 1 });
    expect(events.find((e) => e.type === "sink.save")).toMatchObject({ duplicates: 1 });
  });

  it("drops records a database would choke on and says so", async () => {
    const s = spySink();
    const { ctx, run } = setup(s.sink);
    const bad = [
      rec(1),
      rec(2, { dedupeKey: "" }),
      rec(3, { title: "   " }),
      rec(4, { provider: "" as never }),
      rec(5, { localityName: undefined as never }),
      rec(6, { sourceId: undefined as never }),
      null as never,
      "junk" as never,
    ];
    const out = await saveRecords(ctx, run, bad);
    expect(s.batches[0]?.map((r) => r.dedupeKey)).toEqual(["k:1"]);
    expect(out).toMatchObject({ inserted: 1 });
    expect(run.problems.join()).toContain("dropped 7 invalid record(s)");
  });

  it("clears a date that is not a real calendar date, and keeps good and absent ones", async () => {
    const s = spySink();
    const { ctx, run } = setup(s.sink);
    await saveRecords(ctx, run, [rec(1, { date: "2026-13-45" }), rec(2, { date: "03/01/2026" }), rec(3, { date: "2026-02-30" }), rec(4, { date: "2026-03-01" }), rec(5, { date: null })]);
    expect(s.batches[0]?.map((r) => r.date)).toEqual([null, null, null, "2026-03-01", null]);
    expect(run.problems.join()).toContain("cleared an unreadable date on 3 record(s)");
  });

  it("clears a url that is not http(s), so no javascript: link reaches a page", async () => {
    const s = spySink();
    const { ctx, run } = setup(s.sink);
    await saveRecords(ctx, run, [
      rec(1, { url: "javascript:alert(1)" }),
      rec(2, { url: "data:text/html,<script>1</script>" }),
      rec(3, { url: "/relative/path" }),
      rec(4, { url: "https://ok.example.gov/a?b=1" }),
      rec(5, { url: "http://ok.example.gov/" }),
      rec(6, { url: null }),
      rec(7),
    ]);
    expect(s.batches[0]?.map((r) => r.url ?? null)).toEqual([null, null, null, "https://ok.example.gov/a?b=1", "http://ok.example.gov/", null, null]);
    expect(run.problems.join()).toContain("cleared a non-http(s) url on 3 record(s)");
  });

  it("does not mutate the records it was given", async () => {
    const s = spySink();
    const { ctx, run } = setup(s.sink);
    const input = [rec(1, { date: "2026-13-45", url: "javascript:x" })];
    await saveRecords(ctx, run, input);
    expect(input[0]).toMatchObject({ date: "2026-13-45", url: "javascript:x" });
  });
});

describe("saveRecords: when the sink misbehaves", () => {
  it("rejects a sink that does not return counts, naming the contract", async () => {
    for (const reply of [undefined, null, { inserted: "3", skipped: 0 }, { inserted: -1, skipped: 0 }, { inserted: 1.5, skipped: 0 }, { inserted: 1 }]) {
      const { ctx, run } = setup({ save: (async () => reply) as never });
      await expect(saveRecords(ctx, run, many(2))).rejects.toThrow(/must return \{ inserted, skipped \}/);
    }
  });

  it("fails with a CivicSinkError that says how far it got when a later batch throws", async () => {
    const boom = new Error("deadlock detected");
    const s = spySink((b, call) => {
      if (call === 3) throw boom;
      return { inserted: b.length, skipped: 0 };
    });
    const { ctx, run } = setup(s.sink, { sinkBatchSize: 100 });
    const err = await saveRecords(ctx, run, many(450)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CivicSinkError);
    const e = err as CivicSinkError;
    expect(e.message).toContain("batch 3 of 5");
    expect(e.message).toContain("deadlock detected");
    expect(e.saved).toMatchObject({ inserted: 200, skipped: 0 });
    expect(e.unsaved).toBe(250);
    expect(e.cause).toBe(boom);
    expect(s.batches).toHaveLength(3); // nothing was attempted after the failure
  });

  it("is reported to the run as run.error when it happens inside runAdapter", async () => {
    const events: CivicEvent[] = [];
    const s = spySink(() => {
      throw new Error("connection refused");
    });
    const ctx: AdapterContext = {
      sink: s.sink,
      skipRobotsCheck: true,
      http: { sleep: async () => {} },
      onEvent: (e) => void events.push(e),
      fetch: (async () => new Response(JSON.stringify([{ date: "2026-03-01T00:00:00", offense_type: "Theft", report_number: "R1" }]))) as unknown as typeof fetch,
    };
    await expect(runAdapter({ name: "X" }, { id: 1 }, { provider: "socrata", url: "https://data.example.gov", resourceId: "abcd-1234" }, ctx)).rejects.toBeInstanceOf(CivicSinkError);
    expect(events.at(-1)).toMatchObject({ type: "run.error" });
    expect((events.at(-1) as { message: string }).message).toContain("connection refused");
  });
});

describe("through the adapters", () => {
  it("one case number on two rows is saved once, and a date the parser could not read is cleared", async () => {
    const html = `<table><tr><th>Date</th><th>Offense</th><th>Case Number</th></tr>
      <tr><td>03/01/2026</td><td>Theft</td><td>26-1</td></tr>
      <tr><td>13/45/2026</td><td>Fraud</td><td>26-1</td></tr>
      <tr><td>13/45/2026</td><td>Burglary</td><td>26-2</td></tr></table>`;
    const sink = new MemorySink();
    const r = await runAdapter({ name: "X" }, { id: 1 }, { provider: "blotter_html", url: "https://pd.example.gov/b" }, { sink, skipRobotsCheck: true, fetch: (async () => new Response(html)) as unknown as typeof fetch });
    expect(sink.records.size).toBe(2);
    expect([...sink.records.values()].map((x) => x.date)).toEqual(["2026-03-01", null]);
    expect(r.status).toBe("partial");
    expect(r.problems.join()).toContain("cleared an unreadable date");
  });
});

describe("checkSinkContract", () => {
  it("passes a conforming sink and leaves no failures", async () => {
    expect(await checkSinkContract(new MemorySink())).toEqual({ ok: true, failures: [] });
  });

  it("accepts an upserting sink that reports updates instead of skips", async () => {
    const rows = new Map<string, CivicRecord>();
    const upsert: CivicRecordSink = {
      async save(batch) {
        let inserted = 0;
        let updated = 0;
        for (const r of batch) {
          if (rows.has(r.dedupeKey)) updated++;
          else inserted++;
          rows.set(r.dedupeKey, r);
        }
        return { inserted, skipped: 0, updated };
      },
    };
    expect(await checkSinkContract(upsert)).toEqual({ ok: true, failures: [] });
  });

  it("names each way a sink breaks the contract", async () => {
    const appendOnly: CivicRecordSink = { save: async (b) => ({ inserted: b.length, skipped: 0 }) };
    const r1 = await checkSinkContract(appendOnly);
    expect(r1.ok).toBe(false);
    expect(r1.failures.join("\n")).toMatch(/saving the same records again/);

    const returnsNothing = { save: async () => undefined } as unknown as CivicRecordSink;
    expect((await checkSinkContract(returnsNothing)).failures.join("\n")).toMatch(/return/);

    const throwsOnDuplicate: CivicRecordSink = new (class implements CivicRecordSink {
      seen = new Set<string>();
      async save(b: CivicRecord[]) {
        for (const r of b) {
          if (this.seen.has(r.dedupeKey)) throw new Error("duplicate key value violates unique constraint");
          this.seen.add(r.dedupeKey);
        }
        return { inserted: b.length, skipped: 0 };
      }
    })();
    expect((await checkSinkContract(throwsOnDuplicate)).failures.join("\n")).toMatch(/threw/);

    const throwsOnEmpty: CivicRecordSink = { save: async (b) => { if (!b.length) throw new Error("empty insert"); return { inserted: b.length, skipped: 0 }; } };
    // the library never sends an empty batch, so an empty-batch crash is not a contract failure
    expect((await checkSinkContract(throwsOnEmpty)).failures.join("\n")).not.toMatch(/empty/);
  });

  it("uses keys that cannot collide with real records, and offers them for cleanup", async () => {
    const sink = new MemorySink();
    const cleaned: string[][] = [];
    await checkSinkContract(sink, { cleanup: async (keys) => void cleaned.push(keys) });
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]!.length).toBeGreaterThan(0);
    expect(cleaned[0]!.every((k) => k.startsWith("civic-sink-check:"))).toBe(true);
  });
});
