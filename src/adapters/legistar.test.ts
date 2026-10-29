import { describe, it, expect, vi } from "vitest";
import { ingestLegistar, verifyLegistarClient } from "./legistar.js";
import { MemorySink } from "../types.js";
import type { AdapterContext, Locality, CivicSource } from "../types.js";

const locality: Locality = { name: "Exampleville" };
const source: CivicSource = { id: 1 };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const EVENT = {
  EventId: 100,
  EventDate: "2026-03-04T00:00:00",
  EventTime: "7:00 PM",
  EventBodyName: "City Council",
  EventLocation: "Council Chambers",
  EventAgendaStatusName: "Final",
  EventAgendaFile: "https://example.legistar.com/agenda.pdf",
};

/** Route by URL substring; unmatched routes 404. */
function router(routes: Record<string, () => Response>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    for (const [frag, make] of Object.entries(routes)) if (url.includes(frag)) return make();
    return json({}, 404);
  });
}

function setup(fetchMock: ReturnType<typeof vi.fn>, extra: Partial<AdapterContext> = {}) {
  const sink = new MemorySink();
  const ctx: AdapterContext = { sink, fetch: fetchMock as unknown as typeof fetch, ...extra };
  return { ctx, sink };
}

describe("ingestLegistar", () => {
  it("warns and returns zeros without a clientId", async () => {
    const fetchMock = router({});
    const { ctx } = setup(fetchMock);
    const log = vi.fn();
    ctx.logger = { log };
    // Untyped stored JSON can lack required fields the types demand.
    const bad = { provider: "legistar" } as unknown as Parameters<typeof ingestLegistar>[2];
    expect(await ingestLegistar(locality, source, bad, ctx)).toMatchObject({ inserted: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("missing clientId"), "warn");
  });

  it("queries the webapi host with the since filter", async () => {
    const fetchMock = router({ "/Events?": () => json([]) });
    const { ctx } = setup(fetchMock);
    await ingestLegistar(locality, source, { provider: "legistar", clientId: "ex ample", since: "2026-01-01" }, ctx);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url.startsWith("https://webapi.legistar.com/v1/ex%20ample/Events?")).toBe(true);
    expect(decodeURIComponent(url)).toContain("EventDate ge datetime'2026-01-01'");
  });

  it("records a meeting shell when an event has no agenda items", async () => {
    const fetchMock = router({
      "/Events?": () => json([EVENT]),
      "/EventItems": () => json([]),
    });
    const { ctx, sink } = setup(fetchMock);
    const r = await ingestLegistar(locality, source, { provider: "legistar", clientId: "example" }, ctx);
    expect(r.inserted).toBe(1);
    expect([...sink.records.values()][0]).toMatchObject({
      title: "City Council Meeting — 2026-03-04",
      date: "2026-03-04",
      location: "Council Chambers",
      url: EVENT.EventAgendaFile,
      dedupeKey: "legistar:example:100:meeting",
    });
  });

  it("falls back to a meeting shell when the items request fails", async () => {
    const fetchMock = router({ "/Events?": () => json([EVENT]), "/EventItems": () => json({}, 500) });
    const { ctx, sink } = setup(fetchMock);
    await ingestLegistar(locality, source, { provider: "legistar", clientId: "example" }, ctx);
    expect([...sink.records.keys()]).toEqual(["legistar:example:100:meeting"]);
  });

  it("without summarize, uses title/action/result text as the summary and skips blank titles", async () => {
    const fetchMock = router({
      "/Events?": () => json([EVENT]),
      "/EventItems": () =>
        json([
          {
            EventItemId: 1,
            EventItemTitle: "Rezoning 12 Main St",
            EventItemActionName: "Adopted",
            EventItemPassedFlagName: "Pass",
            EventItemMatterFile: "555",
          },
          { EventItemId: 2, EventItemTitle: "   " },
        ]),
    });
    const { ctx, sink } = setup(fetchMock);
    const r = await ingestLegistar(locality, source, { provider: "legistar", clientId: "example" }, ctx);
    expect(r.inserted).toBe(1);
    expect([...sink.records.values()][0]).toMatchObject({
      title: "Rezoning 12 Main St",
      summary: "Rezoning 12 Main St. Action: Adopted. Result: Pass",
      url: "https://example.legistar.com/MatterDetail.aspx?ID=555",
      dedupeKey: "legistar:example:100:1",
    });
    // No LLM → no attachment lookups.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("MatterAttachments"))).toBe(false);
  });

  it("with summarize, summarizes the fallback text and tolerates attachment failures", async () => {
    const fetchMock = router({
      "/Events?": () => json([EVENT]),
      "/EventItems": () =>
        json([{ EventItemId: 1, EventItemTitle: "Rezoning 12 Main St", EventItemActionName: "Adopted", EventItemMatterFile: "555" }]),
      "MatterAttachments": () => json({}, 500),
    });
    const summarize = vi.fn(async () => "Council rezoned a lot.");
    const { ctx, sink } = setup(fetchMock, { summarize });
    await ingestLegistar(locality, source, { provider: "legistar", clientId: "example" }, ctx);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith(expect.any(String), "Rezoning 12 Main St. Action: Adopted");
    expect([...sink.records.values()][0]?.summary).toBe("Council rezoned a lot.");
  });

  it("dedupes on re-run", async () => {
    const fetchMock = router({ "/Events?": () => json([EVENT]), "/EventItems": () => json([]) });
    const { ctx } = setup(fetchMock);
    const meta = { provider: "legistar", clientId: "example" } as const;
    await ingestLegistar(locality, source, meta, ctx);
    expect(await ingestLegistar(locality, source, meta, ctx)).toMatchObject({ inserted: 0, skipped: 1 });
  });
});

describe("verifyLegistarClient", () => {
  it("is true when the API answers and false on errors or network failure", async () => {
    expect(await verifyLegistarClient("ok", { fetch: router({ "/Bodies": () => json([]) }) as unknown as typeof fetch })).toBe(true);
    expect(await verifyLegistarClient("nope", { fetch: router({}) as unknown as typeof fetch })).toBe(false);
    const boom = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await verifyLegistarClient("x", { fetch: boom as unknown as typeof fetch })).toBe(false);
  });
});

describe("ingestLegistar malformed responses", () => {
  const meta = { provider: "legistar", clientId: "example" } as const;
  const run = async (routes: Record<string, () => Response>, extra: Partial<AdapterContext> = {}) => {
    const log = vi.fn();
    const sink = new MemorySink();
    const ctx: AdapterContext = { sink, logger: { log }, fetch: router(routes) as unknown as typeof fetch, ...extra };
    const p = ingestLegistar(locality, source, meta, ctx);
    return { p, sink, log };
  };

  it("skips events with a null date or missing id instead of throwing, and keeps the good ones", async () => {
    const { p, sink, log } = await run({
      "/Events?": () => json([{ ...EVENT, EventId: 1, EventDate: null }, { ...EVENT, EventId: undefined }, EVENT, null, "junk"]),
      "/EventItems": () => json([]),
    });
    expect((await p).inserted).toBe(1);
    expect([...sink.records.keys()]).toEqual(["legistar:example:100:meeting"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped 4 malformed event"), "warn");
  });

  it("fails with a clear error when the events payload isn't an array", async () => {
    const { p } = await run({ "/Events?": () => json({ Message: "An error has occurred." }) });
    const r = await p;
    expect(r).toMatchObject({ inserted: 0, status: "failed" });
    expect(r.problems.join()).toMatch(/Events.*expected an array/);
  });

  it("falls back to a meeting shell when the items payload isn't an array", async () => {
    const { p, sink } = await run({ "/Events?": () => json([EVENT]), "/EventItems": () => json({ Message: "nope" }) });
    expect((await p).inserted).toBe(1);
    expect([...sink.records.keys()]).toEqual(["legistar:example:100:meeting"]);
  });

  it("skips agenda items without a numeric id and tolerates a missing body name", async () => {
    const { p, sink } = await run({
      "/Events?": () => json([{ ...EVENT, EventBodyName: null }]),
      "/EventItems": () => json([{ EventItemTitle: "No id" }, { EventItemId: 7, EventItemTitle: "Has id" }]),
    });
    expect((await p).inserted).toBe(1);
    expect([...sink.records.keys()]).toEqual(["legistar:example:100:7"]);
  });

  it("titles a body-less meeting shell without printing 'null'", async () => {
    const { p, sink } = await run({ "/Events?": () => json([{ ...EVENT, EventBodyName: null }]), "/EventItems": () => json([]) });
    await p;
    expect([...sink.records.values()][0]?.title).toBe("Meeting — 2026-03-04");
  });
});

describe("ingestLegistar paging and concurrency", () => {
  const events = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      EventId: from + i,
      EventDate: "2026-03-04T00:00:00",
      EventBodyName: "City Council",
    }));
  const meta = { provider: "legistar", clientId: "example", since: "2026-01-01" } as const;
  const skipOf = (url: string) => Number(/\$skip=(\d+)/.exec(decodeURIComponent(url))?.[1] ?? 0);

  it("pages past 50 events until a short page", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/EventItems")) return json([]);
      const skip = skipOf(url);
      return json(skip === 0 ? events(1, 50) : skip === 50 ? events(51, 3) : []);
    });
    const { ctx, sink } = setup(fetchMock);
    const r = await ingestLegistar(locality, source, meta, ctx);
    expect(r).toMatchObject({ status: "ok", inserted: 53, problems: [] });
    expect(sink.records.size).toBe(53);
    const pages = urls.filter((u) => u.includes("/Events?")).map(skipOf);
    expect(pages).toEqual([0, 50]);
  });

  it("stops at maxPages and says the result may be incomplete", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/EventItems")) return json([]);
      return json(events(skipOf(url) + 1, 50));
    });
    const { ctx } = setup(fetchMock);
    const r = await ingestLegistar(locality, source, { ...meta, maxPages: 2 }, ctx);
    expect(r.status).toBe("partial");
    expect(r.inserted).toBe(100);
    expect(r.problems.join()).toMatch(/100 events.*may be incomplete/);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/Events?"))).toHaveLength(2);
  });

  it("fetches agendas in parallel, bounded by meta.concurrency, and keeps event order", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (!url.includes("/EventItems")) return json(events(1, 12));
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const id = Number(/Events\/(\d+)\/EventItems/.exec(url)?.[1]);
      return json([{ EventItemId: id * 10, EventItemTitle: `Item for event ${id}` }]);
    });
    const { ctx, sink } = setup(fetchMock);
    const r = await ingestLegistar(locality, source, { ...meta, concurrency: 3 }, ctx);
    expect(r.status).toBe("ok");
    expect(peak).toBe(3);
    expect([...sink.records.values()].map((x) => x.title)).toEqual(
      Array.from({ length: 12 }, (_, i) => `Item for event ${i + 1}`)
    );
  });

  it("uses a modest default concurrency and clamps absurd values", async () => {
    for (const [concurrency, max] of [[undefined, 4], [500, 8], [0, 1]] as const) {
      let inFlight = 0;
      let peak = 0;
      const fetchMock = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (!url.includes("/EventItems")) return json(events(1, 20));
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return json([]);
      });
      const { ctx } = setup(fetchMock);
      await ingestLegistar(locality, source, { ...meta, concurrency }, ctx);
      expect(peak).toBe(max);
    }
  });

  it("summarizes items in parallel too, within the same bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (!url.includes("/EventItems")) return json(events(1, 1));
      return json(Array.from({ length: 10 }, (_, i) => ({ EventItemId: i + 1, EventItemTitle: `A sufficiently long title ${i}` })));
    });
    const { ctx } = setup(fetchMock, {
      summarize: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        inFlight--;
        return "summary";
      },
    });
    const r = await ingestLegistar(locality, source, { ...meta, concurrency: 5 }, ctx);
    expect(r).toMatchObject({ status: "ok", inserted: 10 });
    expect(peak).toBe(5);
  });
});
