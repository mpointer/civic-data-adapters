// AdapterResult.status / problems: a caller must be able to tell a quiet day
// from a dead URL, a refusal, a bad config and a half-finished run.
import { describe, it, expect, vi } from "vitest";
import { runAdapter } from "./registry.js";
import { MemorySink } from "./types.js";
import type { AdapterContext, CivicSource, Locality } from "./types.js";

const locality: Locality = { name: "Exampleville", state: "PA" };
const source: CivicSource = { id: 1 };

function ctxWith(fetchImpl: (url: string, init?: RequestInit) => Response | Promise<Response>, extra: Partial<AdapterContext> = {}) {
  const log = vi.fn();
  const sink = new MemorySink();
  const ctx: AdapterContext = {
    sink,
    logger: { log },
    skipRobotsCheck: true,
    fetch: vi.fn(async (input: unknown, init?: RequestInit) => fetchImpl(String(input), init)) as unknown as typeof fetch,
    ...extra,
  };
  return { ctx, sink, log };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("registry", () => {
  it("reports a stub provider as skipped and an unknown provider as failed", async () => {
    const { ctx } = ctxWith(() => json({}));
    expect(await runAdapter(locality, source, { provider: "granicus" }, ctx)).toMatchObject({
      status: "skipped",
      inserted: 0,
    });
    const bad = { provider: "nope" } as unknown as Parameters<typeof runAdapter>[2];
    const r = await runAdapter(locality, source, bad, ctx);
    expect(r.status).toBe("failed");
    expect(r.problems[0]).toContain("unknown provider 'nope'");
  });
});

describe("blotter_html", () => {
  const meta = { provider: "blotter_html", url: "https://pd.example.gov/b" } as const;
  const rows = (n: number) =>
    `<table><tr><th>Date</th><th>Offense</th><th>Location</th></tr>${Array.from(
      { length: n },
      (_, i) => `<tr><td>03/0${(i % 9) + 1}/2026</td><td>Theft ${i}</td><td>${i} Main St</td></tr>`
    ).join("")}</table>`;

  it("ok with data", async () => {
    const { ctx } = ctxWith(() => new Response(rows(3)));
    expect(await runAdapter(locality, source, meta, ctx)).toEqual({ inserted: 3, skipped: 0, status: "ok", problems: [] });
  });
  it("failed on HTTP error, network error and a page with no table", async () => {
    for (const make of [() => new Response("", { status: 503 }), () => { throw new Error("ECONNRESET"); }, () => new Response("<p>JS app</p>")]) {
      const { ctx } = ctxWith(make);
      const r = await runAdapter(locality, source, meta, ctx);
      expect(r.status).toBe("failed");
      expect(r.problems).toHaveLength(1);
    }
  });
  it("skipped when robots.txt refuses", async () => {
    const { ctx } = ctxWith(() => new Response(rows(2)), { skipRobotsCheck: false, robotsCheck: async () => false });
    expect(await runAdapter(locality, source, meta, ctx)).toMatchObject({ status: "skipped", inserted: 0 });
  });
  it("partial when the table is longer than the row cap", async () => {
    const { ctx } = ctxWith(() => new Response(rows(520)));
    const r = await runAdapter(locality, source, meta, ctx);
    expect(r.status).toBe("partial");
    expect(r.problems.join()).toContain("only the first 500");
  });
});

describe("blotter_pdf", () => {
  const meta = { provider: "blotter_pdf", url: "https://pd.example.gov/b.pdf" } as const;
  it("failed on HTTP error; skipped on robots refusal", async () => {
    expect((await runAdapter(locality, source, meta, ctxWith(() => new Response("", { status: 500 })).ctx)).status).toBe("failed");
    const { ctx } = ctxWith(() => new Response("x"), { skipRobotsCheck: false, robotsCheck: async () => false });
    expect((await runAdapter(locality, source, meta, ctx)).status).toBe("skipped");
  });
  it("failed when the bytes are not a PDF", async () => {
    const r = await runAdapter(locality, source, meta, ctxWith(() => new Response("not a pdf")).ctx);
    expect(r.status).toBe("failed");
  });
});

describe("socrata", () => {
  const meta = { provider: "socrata", url: "https://data.example.gov", resourceId: "abcd-1234" } as const;
  const row = (i: number) => ({ date: "2026-03-01T00:00:00", offense_type: `Theft ${i}`, report_number: `R${i}` });

  it("ok when the dataset is simply empty", async () => {
    const { ctx } = ctxWith(() => json([]));
    expect(await runAdapter(locality, source, meta, ctx)).toEqual({ inserted: 0, skipped: 0, status: "ok", problems: [] });
  });
  it("failed on a bad config and on an error on the first page", async () => {
    const { ctx } = ctxWith(() => json({ message: "nope" }, 500));
    expect((await runAdapter(locality, source, meta, ctx)).status).toBe("failed");
    const bad = { provider: "socrata" } as unknown as Parameters<typeof runAdapter>[2];
    expect((await runAdapter(locality, source, bad, ctx)).status).toBe("failed");
  });
  it("failed when the body is not an array", async () => {
    const r = await runAdapter(locality, source, meta, ctxWith(() => json({ error: true })).ctx);
    expect(r).toMatchObject({ status: "failed" });
    expect(r.problems[0]).toContain("unexpected response shape");
  });
  it("partial when a later page fails after the first saved data", async () => {
    let call = 0;
    const { ctx } = ctxWith(() => (call++ === 0 ? json(Array.from({ length: 1000 }, (_, i) => row(i))) : json({}, 503)));
    const r = await runAdapter(locality, source, meta, ctx);
    expect(r.status).toBe("partial");
    expect(r.inserted).toBe(1000);
    expect(r.problems[0]).toContain("HTTP 503");
    expect(r.problems[0]).toContain("page 2");
  });
  it("partial when the page cap is hit", async () => {
    const { ctx } = ctxWith(() => json(Array.from({ length: 1000 }, (_, i) => row(i))));
    const r = await runAdapter(locality, source, { ...meta, maxPages: 1 }, ctx);
    expect(r.status).toBe("partial");
    expect(r.problems[0]).toContain("page cap");
  });
  it("partial when some rows are not objects", async () => {
    const { ctx } = ctxWith(() => json([row(1), null, 7, row(2)]));
    const r = await runAdapter(locality, source, meta, ctx);
    expect(r).toMatchObject({ status: "partial", inserted: 2 });
    expect(r.problems[0]).toContain("skipped 2 malformed");
  });
});

describe("usaspending", () => {
  const meta = { provider: "usaspending", awardTypes: "contracts" } as const;
  const award = (id: string) => ({
    "Award ID": id,
    "Recipient Name": "Acme",
    "Award Amount": 1,
    Description: "x",
    "Awarding Agency": "DOT",
    "Start Date": "2026-01-02",
  });
  it("failed without locality.state", async () => {
    const r = await runAdapter({ name: "Exampleville" }, source, meta, ctxWith(() => json({})).ctx);
    expect(r.status).toBe("failed");
  });
  it("ok on a clean last page; failed on an error payload", async () => {
    const ok = ctxWith(() => json({ results: [award("A")], page_metadata: { has_next_page: false } }));
    expect((await runAdapter(locality, source, meta, ok.ctx)).status).toBe("ok");
    const bad = ctxWith(() => json({ detail: "boom" }));
    expect((await runAdapter(locality, source, meta, bad.ctx)).status).toBe("failed");
  });
  it("partial when a later page fails", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const { ctx } = ctxWith(() => (call++ === 0 ? json({ results: [award("A")], page_metadata: { has_next_page: true } }) : json({}, 500)));
      const p = runAdapter(locality, source, meta, ctx);
      await vi.runAllTimersAsync();
      const r = await p;
      expect(r).toMatchObject({ status: "partial", inserted: 1 });
      expect(r.problems[0]).toContain("HTTP 500 on page 2");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("nonprofit_explorer", () => {
  const meta = { provider: "nonprofit_explorer" } as const;
  it("failed without state; failed on an error payload; ok when empty", async () => {
    expect((await runAdapter({ name: "Exampleville" }, source, meta, ctxWith(() => json({})).ctx)).status).toBe("failed");
    expect((await runAdapter(locality, source, meta, ctxWith(() => json({ error: "x" })).ctx)).status).toBe("failed");
    const empty = ctxWith(() => json({ total_results: 0, num_pages: 1, cur_page: 0, organizations: [] }));
    expect(await runAdapter(locality, source, meta, empty.ctx)).toEqual({ inserted: 0, skipped: 0, status: "ok", problems: [] });
  });
  it("skipped on a robots refusal", async () => {
    const { ctx } = ctxWith(() => json({}), { skipRobotsCheck: false, robotsCheck: async () => false });
    expect((await runAdapter(locality, source, meta, ctx)).status).toBe("skipped");
  });
});

describe("legistar", () => {
  const meta = { provider: "legistar", clientId: "example", since: "2026-01-01" } as const;
  const EVENT = { EventId: 1, EventDate: "2026-03-04T00:00:00", EventBodyName: "Council" };
  const ITEM = { EventItemId: 10, EventItemTitle: "Approve the budget for fiscal year" };

  it("failed (not a throw) when the Events request fails or has the wrong shape", async () => {
    expect((await runAdapter(locality, source, meta, ctxWith(() => json({}, 500)).ctx)).status).toBe("failed");
    expect((await runAdapter(locality, source, meta, ctxWith(() => json({ Message: "err" })).ctx)).status).toBe("failed");
    const bad = { provider: "legistar" } as unknown as Parameters<typeof runAdapter>[2];
    expect((await runAdapter(locality, source, bad, ctxWith(() => json([])).ctx)).status).toBe("failed");
  });
  it("ok when everything answers", async () => {
    const { ctx } = ctxWith((url) => (url.includes("/EventItems") ? json([ITEM]) : json([EVENT])));
    expect(await runAdapter(locality, source, meta, ctx)).toMatchObject({ status: "ok", inserted: 1, problems: [] });
  });
  it("partial when an agenda cannot be read: the meeting shell is still saved", async () => {
    const { ctx } = ctxWith((url) => (url.includes("/EventItems") ? json({}, 500) : json([EVENT])));
    const r = await runAdapter(locality, source, meta, ctx);
    expect(r).toMatchObject({ status: "partial", inserted: 1 });
    expect(r.problems[0]).toContain("could not read the agenda for 1 meeting");
  });
  it("partial, not a throw, when the summarize callback fails; the item keeps its title text", async () => {
    const { ctx, sink } = ctxWith((url) => (url.includes("/EventItems") ? json([ITEM]) : json([EVENT])), {
      summarize: async () => {
        throw new Error("quota");
      },
    });
    const r = await runAdapter(locality, source, meta, ctx);
    expect(r).toMatchObject({ status: "partial", inserted: 1 });
    expect([...sink.records.values()][0]?.summary).toBe("Approve the budget for fiscal year");
  });
});

describe("html_minutes", () => {
  const meta = { provider: "html_minutes", url: "https://minutes.example.gov/m" } as const;
  const page = (n: number) => `<html><body>Budget ${"word ".repeat(n)}</body></html>`;
  const items = JSON.stringify([{ title: "Budget", action: "Approved" }]);

  it("failed without a summarize callback and when the page can't be fetched", async () => {
    expect((await runAdapter(locality, source, meta, ctxWith(() => new Response(page(10))).ctx)).status).toBe("failed");
    const { ctx } = ctxWith(() => new Response("", { status: 404 }), { summarize: async () => items });
    expect((await runAdapter(locality, source, meta, ctx)).status).toBe("failed");
  });
  it("failed when summarize throws or replies with prose", async () => {
    const boom = ctxWith(() => new Response(page(10)), { summarize: async () => { throw new Error("quota"); } });
    expect((await runAdapter(locality, source, meta, boom.ctx)).status).toBe("failed");
    const prose = ctxWith(() => new Response(page(10)), { summarize: async () => "I could not find any items." });
    expect((await runAdapter(locality, source, meta, prose.ctx)).status).toBe("failed");
  });
  it("ok on a clean parse; partial when the page was truncated", async () => {
    const ok = ctxWith(() => new Response(page(10)), { summarize: async () => items });
    expect(await runAdapter(locality, source, meta, ok.ctx)).toMatchObject({ status: "ok", inserted: 1 });
    const long = ctxWith(() => new Response(page(20_000)), { summarize: async () => items });
    const r = await runAdapter(locality, source, meta, long.ctx);
    expect(r.status).toBe("partial");
    expect(r.problems[0]).toContain("truncated");
  });
});

describe("blotter_crimewatch", () => {
  const meta = { provider: "blotter_crimewatch", url: "https://crimewatch.net/us/pa/x/incidents" } as const;
  it("failed when the page errors; skipped on a robots refusal", async () => {
    expect((await runAdapter(locality, source, meta, ctxWith(() => new Response("", { status: 500 })).ctx)).status).toBe("failed");
    const { ctx } = ctxWith(() => new Response("x"), { skipRobotsCheck: false, robotsCheck: async () => false });
    expect((await runAdapter(locality, source, meta, ctx)).status).toBe("skipped");
  });
});
