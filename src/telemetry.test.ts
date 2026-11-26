import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAdapter } from "./registry.js";
import { ingestSocrataRecords } from "./adapters/blotter-socrata.js";
import { discoverBlotter } from "./discovery/blotter.js";
import { resetHttpState } from "./http.js";
import { MemorySink } from "./types.js";
import type { AdapterContext, CivicEvent, CivicRecordSink, Locality } from "./types.js";

const locality: Locality = { name: "Exampleville", state: "PA" };
const source = { id: 42 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const socrataMeta = { provider: "socrata", url: "https://data.example.gov", resourceId: "abcd-1234" } as const;
const row = (i: number) => ({ date: "2026-03-01T00:00:00", offense_type: `Theft ${i}`, report_number: `R${i}` });

function ctxWith(fetchImpl: (url: string) => Response | Promise<Response>, extra: Partial<AdapterContext> = {}) {
  const events: CivicEvent[] = [];
  const ctx: AdapterContext = {
    sink: new MemorySink(),
    skipRobotsCheck: true,
    http: { sleep: async () => {} },
    fetch: (async (input: unknown) => fetchImpl(String(input))) as unknown as typeof fetch,
    onEvent: (e) => void events.push(e),
    ...extra,
  };
  return { ctx, events };
}

beforeEach(() => resetHttpState());

describe("run events", () => {
  it("brackets a run with start and end, all carrying one runId and the run's identity", async () => {
    const { ctx, events } = ctxWith(() => json([row(1), row(2)]));
    const r = await runAdapter(locality, source, socrataMeta, ctx);
    expect(events[0]).toMatchObject({ type: "run.start", provider: "socrata", locality: "Exampleville", sourceId: 42 });
    const end = events.at(-1);
    expect(end).toMatchObject({ type: "run.end", status: "ok", inserted: 2, skipped: 0, problems: 0 });
    expect(new Set(events.map((e) => e.runId)).size).toBe(1);
    expect(events[0]?.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.stats).toEqual((end as Extract<CivicEvent, { type: "run.end" }>).stats);
  });

  it("puts counters on the result, even without an event hook", async () => {
    const { ctx } = ctxWith(() => json([row(1)]), { onEvent: undefined });
    const r = await runAdapter(locality, source, socrataMeta, ctx);
    expect(r.stats).toMatchObject({ requests: 1, retries: 0, llmCalls: 0 });
    expect(r.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("gives skipped and failed results stats too, including stub and unknown providers", async () => {
    const { ctx } = ctxWith(() => json({}));
    expect((await runAdapter(locality, source, { provider: "granicus" }, ctx)).stats).toMatchObject({ requests: 0 });
    const bad = { provider: "nope" } as unknown as Parameters<typeof runAdapter>[2];
    expect((await runAdapter(locality, source, bad, ctx)).stats).toBeDefined();
    const down = ctxWith(() => json({}, 404));
    expect((await runAdapter(locality, source, socrataMeta, down.ctx)).stats.requests).toBe(1);
  });

  it("instruments an adapter called directly, not only through runAdapter", async () => {
    const { ctx, events } = ctxWith(() => json([row(1)]));
    const r = await ingestSocrataRecords(locality, source, socrataMeta, ctx);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["run.start", "http.attempt", "run.end"]));
    expect(r.stats.requests).toBe(1);
    expect(events.filter((e) => e.type === "run.start")).toHaveLength(1); // not doubled
  });

  it("emits each problem as an event and counts them in run.end", async () => {
    const { ctx, events } = ctxWith(() => json([row(1), null, 7]));
    await runAdapter(locality, source, socrataMeta, ctx);
    const problems = events.filter((e): e is Extract<CivicEvent, { type: "problem" }> => e.type === "problem");
    expect(problems.map((p) => p.message)).toEqual(["skipped 2 malformed row(s)"]);
    expect(events.at(-1)).toMatchObject({ type: "run.end", status: "partial", problems: 1 });
  });

  it("emits run.error and rethrows when the sink itself throws", async () => {
    const sink: CivicRecordSink = {
      save: async () => {
        throw new Error("disk full");
      },
    };
    const { ctx, events } = ctxWith(() => json([row(1)]), { sink });
    await expect(runAdapter(locality, source, socrataMeta, ctx)).rejects.toThrow("disk full");
    expect(events.at(-1)).toMatchObject({ type: "run.error", message: "disk full" });
    expect(events.some((e) => e.type === "run.end")).toBe(false);
  });
});

describe("http events", () => {
  it("emits one attempt per request with host, path, status and timing", async () => {
    const { ctx, events } = ctxWith(() => json([row(1)]));
    await runAdapter(locality, source, socrataMeta, ctx);
    const attempts = events.filter((e): e is Extract<CivicEvent, { type: "http.attempt" }> => e.type === "http.attempt");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ host: "data.example.gov", method: "GET", path: "/resource/abcd-1234.json", status: 200, attempt: 1 });
    expect(attempts[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("never puts a query string, a key or a request body in an event", async () => {
    const secret = "SECRET-API-KEY-123";
    const { ctx, events } = ctxWith((url) => {
      if (url.includes("services/session/token")) return new Response("tok");
      if (url.includes("api/cw_web/feed")) return json({ results: [], page: 0, pages: 1, count: 0 });
      return new Response(`<script>jQuery.extend(Drupal.settings, ${JSON.stringify({ cw_web: { api_key: secret, site_path: "https://crimewatch.net", base_path: "/", feed: { data: { gid: "42" } } } })});</script>`);
    });
    await runAdapter(locality, source, { provider: "blotter_crimewatch", url: "https://crimewatch.net/us/pa/x/incidents?token=ALSO-SECRET" }, ctx);
    const blob = JSON.stringify(events);
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain("ALSO-SECRET");
    expect(blob).not.toContain("api-key");
    expect(events.some((e) => e.type === "http.attempt" && e.path.includes("cw_web/feed"))).toBe(true);
    // and a Socrata filter value, which is in the query string
    const s = ctxWith(() => json([]));
    await runAdapter(locality, source, socrataMeta, s.ctx);
    expect(JSON.stringify(s.events)).not.toContain("$where");
  });

  it("records a retry: two attempts, one http.retry, and the counters", async () => {
    let n = 0;
    const { ctx, events } = ctxWith(() => (++n === 1 ? new Response(null, { status: 503 }) : json([row(1)])));
    const r = await runAdapter(locality, source, socrataMeta, ctx);
    expect(events.filter((e) => e.type.startsWith("http.")).map((e) => e.type)).toEqual(["http.attempt", "http.retry", "http.attempt"]);
    expect(events.find((e) => e.type === "http.retry")).toMatchObject({ host: "data.example.gov", reason: "HTTP 503", attempt: 1 });
    expect(events.filter((e) => e.type === "http.attempt").map((e) => (e as { status?: number }).status)).toEqual([503, 200]);
    expect(r.stats).toMatchObject({ requests: 2, retries: 1 });
  });

  it("records a failed attempt's error without its URL query", async () => {
    const { ctx, events } = ctxWith(() => {
      throw new TypeError("fetch failed");
    });
    await runAdapter(locality, source, { ...socrataMeta }, { ...ctx, http: { retries: 0 } });
    expect(events.find((e) => e.type === "http.attempt")).toMatchObject({ error: "fetch failed" });
  });

  it("keeps concurrent runs apart", async () => {
    const mk = (n: number) => {
      const { ctx, events } = ctxWith(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return json([]);
      });
      return { ctx, events, n };
    };
    const a = mk(1);
    const b = mk(2);
    const [ra, rb] = await Promise.all([
      runAdapter(locality, { id: "A" }, { provider: "legistar", clientId: "a" }, a.ctx),
      runAdapter({ name: "Other" }, { id: "B" }, { provider: "legistar", clientId: "b" }, b.ctx),
    ]);
    expect(new Set(a.events.map((e) => e.runId)).size).toBe(1);
    expect(new Set(b.events.map((e) => e.runId)).size).toBe(1);
    expect(a.events[0]?.runId).not.toBe(b.events[0]?.runId);
    expect(a.events.every((e) => e.sourceId === "A")).toBe(true);
    expect(ra.stats.requests).toBe(1);
    expect(rb.stats.requests).toBe(1);
  });
});

describe("the hook can never hurt a run", () => {
  it("swallows a throwing hook and a rejecting async hook", async () => {
    const boom = ctxWith(() => json([row(1)]), {
      onEvent: () => {
        throw new Error("telemetry down");
      },
    });
    expect(await runAdapter(locality, source, socrataMeta, boom.ctx)).toMatchObject({ status: "ok", inserted: 1 });
    const rejects = ctxWith(() => json([row(1)]), { onEvent: (async () => Promise.reject(new Error("async down"))) as unknown as AdapterContext["onEvent"] });
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    expect(await runAdapter(locality, source, socrataMeta, rejects.ctx)).toMatchObject({ status: "ok" });
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener("unhandledRejection", unhandled);
  });
});

describe("discovery", () => {
  it("reports its http attempts, outside any run", async () => {
    const events: CivicEvent[] = [];
    await discoverBlotter(
      locality,
      {
        generate: async () => JSON.stringify([{ url: "https://pd.example.gov/blotter" }]),
        fetch: (async () => new Response("<p>nothing</p>")) as unknown as typeof fetch,
        skipRobotsCheck: true,
        onEvent: (e) => void events.push(e),
      }
    );
    const attempts = events.filter((e) => e.type === "http.attempt");
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((e) => e.runId === undefined)).toBe(true);
  });
});
