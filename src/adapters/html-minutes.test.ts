import { describe, it, expect, vi } from "vitest";
import { ingestHtmlMinutes, legacyMinutesDedupeKey, minutesDedupeKey } from "./html-minutes.js";
import { MemorySink } from "../types.js";
import type { AdapterContext, Locality, CivicSource } from "../types.js";

const locality: Locality = { name: "Exampleville" };
const source: CivicSource = { id: 7 };
const PAGE = "<html><script>x()</script><body><h1>Minutes</h1><p>Motion to approve budget passed.</p></body></html>";

function setup(summarize?: AdapterContext["summarize"], html = PAGE) {
  const sink = new MemorySink();
  const log = vi.fn();
  const fetchMock = vi.fn(async () => new Response(html, { headers: { "content-type": "text/html" } }));
  const ctx: AdapterContext = {
    sink,
    logger: { log },
    fetch: fetchMock as unknown as typeof fetch,
    skipRobotsCheck: true,
    summarize,
  };
  return { ctx, sink, log, fetchMock };
}

const meta = { provider: "html_minutes", url: "https://minutes.example.gov/2026-03" } as const;
// Extracted titles must appear in the page, so fixtures that return items need a page that has them.
const GROUNDED = `<html><body>Approve budget, Voted, Approved 5-2. Bogus future date. Public comment.
Resolution 2026-62: Revision to the City's Official Sewage Facilities Plan.
Resolution 2026-63: Appointments to Junior Council.
Resolution 2026-64: Continuation of the Trap-Neuter-Return Program.</body></html>`;

describe("ingestHtmlMinutes", () => {
  it("skips with a warning when no LLM callback is provided", async () => {
    const { ctx, log, fetchMock } = setup(undefined);
    expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toMatchObject({ inserted: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("requires ctx.summarize"), "warn");
  });

  it("strips scripts/tags before handing text to the model", async () => {
    const summarize = vi.fn(async () => "[]");
    const { ctx } = setup(summarize);
    await ingestHtmlMinutes(locality, source, meta, ctx);
    expect(summarize).toHaveBeenCalledWith(expect.any(String), "Minutes Motion to approve budget passed.");
  });

  it("ingests validated items, sanitizes dates, and drops malformed ones", async () => {
    const future = new Date(Date.now() + 800 * 86_400_000).toISOString().slice(0, 10);
    const summarize = vi.fn(async () =>
      "```json\n" +
        JSON.stringify([
          { title: "Approve budget", action: "Voted", result: "Approved 5-2", date: "2026-03-04" },
          { title: "Bogus future date", date: future },
          { action: "no title" },
          { title: 42 },
        ]) +
        "\n```"
    );
    const { ctx, sink, log } = setup(summarize, GROUNDED);
    const result = await ingestHtmlMinutes(locality, source, meta, ctx);

    expect(result).toMatchObject({ inserted: 2, skipped: 0 });
    const recs = [...sink.records.values()];
    expect(recs[0]).toMatchObject({
      provider: "html_minutes",
      type: "council_meeting",
      title: "Approve budget",
      summary: "Voted — Approved 5-2",
      date: "2026-03-04",
      url: meta.url,
    });
    expect(recs[1]?.date).toBeNull(); // far-future date rejected, as in every other adapter
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dropped 2 malformed"), "warn");
  });

  it("is idempotent across runs", async () => {
    const summarize = vi.fn(async () => JSON.stringify([{ title: "Approve budget" }]));
    const { ctx } = setup(summarize);
    expect((await ingestHtmlMinutes(locality, source, meta, ctx)).inserted).toBe(1);
    expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toMatchObject({ inserted: 0, skipped: 1 });
  });

  describe("dedupe keys", () => {
    // Real case: Hazleton, 2026-10-13 council agenda. The first nine characters of these
    // titles are identical, so the pre-0.4 key kept 1 of 3 here (and 3 of 9 on the full agenda).
    const TITLES = [
      "Resolution 2026-62: Revision to the City's Official Sewage Facilities Plan",
      "Resolution 2026-63: Appointments to Junior Council",
      "Resolution 2026-64: Continuation of the Trap-Neuter-Return Program",
    ];

    it("keeps items that share their opening words distinct (the 0.3 bug)", async () => {
      const summarize = vi.fn(async () => JSON.stringify(TITLES.map((title) => ({ title }))));
      const { ctx, sink } = setup(summarize, GROUNDED);
      expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toMatchObject({ inserted: 3, skipped: 0 });
      expect(sink.records.size).toBe(3);
      // ...and the legacy key really did collapse them
      expect(new Set(TITLES.map((t) => legacyMinutesDedupeKey(7, t))).size).toBe(1);
    });

    it("keeps a recurring item distinct per meeting, but a re-run of the same document is a no-op", async () => {
      const summarize = vi.fn(async () => JSON.stringify([{ title: "Public comment" }]));
      const { ctx } = setup(summarize, GROUNDED);
      const march = { provider: "html_minutes", url: "https://minutes.example.gov/2026-03" } as const;
      const april = { provider: "html_minutes", url: "https://minutes.example.gov/2026-04" } as const;
      expect((await ingestHtmlMinutes(locality, source, march, ctx)).inserted).toBe(1);
      expect((await ingestHtmlMinutes(locality, source, april, ctx)).inserted).toBe(1);
      expect(await ingestHtmlMinutes(locality, source, march, ctx)).toMatchObject({ inserted: 0, skipped: 1 });
    });

    it("ignores case and surrounding whitespace in the title, but not the source or the document", () => {
      const k = minutesDedupeKey(7, "https://x.gov/a.pdf", "Approve budget");
      expect(minutesDedupeKey(7, "https://x.gov/a.pdf", "  APPROVE budget ")).toBe(k);
      expect(minutesDedupeKey(8, "https://x.gov/a.pdf", "Approve budget")).not.toBe(k);
      expect(minutesDedupeKey(7, "https://x.gov/b.pdf", "Approve budget")).not.toBe(k);
    });

    it("pins the algorithm with known answers (consumers store these; changing them re-inserts every row)", () => {
      expect(minutesDedupeKey(7, "https://x.gov/agenda.pdf", "Item")).toBe("htmlminutes:7:467405ffc4f5b07a");
      expect(minutesDedupeKey(7, "https://minutes.example.gov/2026-03", "Approve budget")).toBe("htmlminutes:7:134da75d58db8cee");
    });

    it("exposes the legacy key for migrating rows stored by 0.3", () => {
      expect(legacyMinutesDedupeKey(7, "Approve budget")).toBe("htmlminutes:7:QXBwcm92ZSBi");
    });
  });

  it("returns zeros when the model replies with prose instead of JSON", async () => {
    const { ctx, log, sink } = setup(async () => "There were no actionable items.");
    expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toMatchObject({ inserted: 0, skipped: 0 });
    expect(sink.records.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("parse failed"), "warn");
  });

  it("survives the summarize callback throwing", async () => {
    const { ctx, log } = setup(async () => {
      throw new Error("rate limited");
    });
    expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toMatchObject({ inserted: 0, skipped: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("rate limited"), "warn");
  });

  it("warns when there is no url", async () => {
    const { ctx, log } = setup(async () => "[]");
    await ingestHtmlMinutes(locality, source, { provider: "html_minutes" }, ctx);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no URL"), "warn");
  });
});

const para = (n: number) =>
  `Motion ${n} to approve contract number ${n} for street paving on the north side of town passed 5-2 after a short discussion by council members.`;
const pageOf = (paras: string[]) => `<html><body>${paras.join(" ")}</body></html>`;
/** A model stand-in: one item per "Motion N" paragraph found in the text it is given. */
const extractMotions = async (_sys: string, text: string) =>
  JSON.stringify(
    [...text.matchAll(/Motion (\d+) to approve contract number \d+/g)].map((m) => ({
      title: m[0],
      action: "Approve contract",
      result: "Passed 5-2",
    }))
  );

describe("ingestHtmlMinutes: long documents are chunked, not truncated", () => {
  it("reads every part of a document longer than one model call, once per item", async () => {
    const paras = Array.from({ length: 100 }, (_, i) => para(i + 1));
    const calls: string[] = [];
    const { ctx, sink } = setup(async (sys, text) => {
      calls.push(text);
      return extractMotions(sys, text);
    }, pageOf(paras));
    const r = await ingestHtmlMinutes(locality, source, meta, ctx);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c.length).toBeLessThanOrEqual(8_000);
    expect(r).toMatchObject({ status: "ok", problems: [], inserted: 100 });
    expect(sink.records.size).toBe(100); // overlap between chunks must not double-count
    const titles = [...sink.records.values()].map((x) => x.title);
    expect(titles[0]).toContain("Motion 1 ");
    expect(titles[99]).toContain("Motion 100 ");
  });

  it("does not split a document that fits in one call", async () => {
    const summarize = vi.fn(extractMotions);
    const { ctx } = setup(summarize, pageOf([para(1), para(2)]));
    await ingestHtmlMinutes(locality, source, meta, ctx);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("reports partial when the document is longer than the chunk budget", async () => {
    const { ctx, sink } = setup(extractMotions, pageOf(Array.from({ length: 700 }, (_, i) => para(i + 1))));
    const r = await ingestHtmlMinutes(locality, source, meta, ctx);
    expect(r.status).toBe("partial");
    expect(r.problems.join()).toMatch(/truncated from \d+ to 64000 chars/);
    expect(sink.records.size).toBeGreaterThan(0);
  });

  it("is partial, keeping the rest, when one chunk's model call fails", async () => {
    let n = 0;
    const { ctx, sink } = setup(async (sys, text) => {
      if (n++ === 1) throw new Error("quota");
      return extractMotions(sys, text);
    }, pageOf(Array.from({ length: 100 }, (_, i) => para(i + 1))));
    const r = await ingestHtmlMinutes(locality, source, meta, ctx);
    expect(r.status).toBe("partial");
    expect(r.problems.join()).toMatch(/1 of \d+ section\(s\) failed/);
    expect(sink.records.size).toBeGreaterThan(0);
    expect(sink.records.size).toBeLessThan(100);
  });

  it("fails when every chunk fails", async () => {
    const { ctx } = setup(async () => {
      throw new Error("quota");
    }, pageOf(Array.from({ length: 100 }, (_, i) => para(i + 1))));
    expect((await ingestHtmlMinutes(locality, source, meta, ctx)).status).toBe("failed");
  });

  it("keeps up to 200 items and says when it drops the rest", async () => {
    const many = JSON.stringify(Array.from({ length: 230 }, (_, i) => ({ title: `Item number ${i}` })));
    const text = Array.from({ length: 230 }, (_, i) => `Item number ${i}`).join(" ");
    const { ctx, sink } = setup(async () => many, `<p>${text}</p>`);
    const r = await ingestHtmlMinutes(locality, source, meta, ctx);
    expect(r).toMatchObject({ status: "partial", inserted: 200 });
    expect(sink.records.size).toBe(200);
    expect(r.problems.join()).toMatch(/kept 200 of 230/);
  });
});

describe("ingestHtmlMinutes: the model may not invent items", () => {
  const text = "Council voted to approve the Elm Street resurfacing contract with Acme Paving, passed 5-2. The mayor adjourned the meeting.";

  it("drops items whose title is not in the source text", async () => {
    const reply = JSON.stringify([
      { title: "Approve the Elm Street resurfacing contract with Acme Paving", result: "Passed 5-2" },
      { title: "Authorize purchase of a new fire engine", result: "Passed unanimously" },
    ]);
    const { ctx, sink } = setup(async () => reply, `<p>${text}</p>`);
    const r = await ingestHtmlMinutes(locality, source, meta, ctx);
    expect(r).toMatchObject({ status: "partial", inserted: 1 });
    expect([...sink.records.values()].map((x) => x.title)).toEqual(["Approve the Elm Street resurfacing contract with Acme Paving"]);
    expect(r.problems.join()).toMatch(/1 item\(s\) not found in the source text/);
  });

  it("keeps a reasonable paraphrase", async () => {
    const reply = JSON.stringify([{ title: "Elm Street resurfacing contract approved (Acme Paving)" }]);
    const { ctx } = setup(async () => reply, `<p>${text}</p>`);
    expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toMatchObject({ status: "ok", inserted: 1 });
  });

  it("nulls a vote tally the text does not contain but keeps the item", async () => {
    const reply = JSON.stringify([{ title: "Approve the Elm Street resurfacing contract with Acme Paving", result: "Approved 7-0" }]);
    const { ctx, sink } = setup(async () => reply, `<p>${text}</p>`);
    const r = await ingestHtmlMinutes(locality, source, meta, ctx);
    expect(r).toMatchObject({ status: "partial", inserted: 1 });
    expect([...sink.records.values()][0]?.summary).toBeNull();
    expect(r.problems.join()).toMatch(/1 result\(s\) .*not in the source text/);
  });

  it("keeps a tally that is in the text, however it is written", async () => {
    const reply = JSON.stringify([{ title: "Approve the Elm Street resurfacing contract with Acme Paving", result: "Approved 5 to 2" }]);
    const { ctx } = setup(async () => reply, `<p>${text}</p>`);
    expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toMatchObject({ status: "ok" });
  });
});

describe("ingestHtmlMinutes: fetch failures say why", () => {
  it("reports the HTTP status, and skips on a robots refusal", async () => {
    const { ctx } = setup(async () => "[]");
    ctx.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const r = await ingestHtmlMinutes(locality, source, meta, ctx);
    expect(r.status).toBe("failed");
    expect(r.problems.join()).toContain("HTTP 404");
    const denied = setup(async () => "[]");
    denied.ctx.skipRobotsCheck = false;
    denied.ctx.robotsCheck = async () => false;
    expect((await ingestHtmlMinutes(locality, source, meta, denied.ctx)).status).toBe("skipped");
  });
});
