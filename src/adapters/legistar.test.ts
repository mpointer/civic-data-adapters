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
    expect(await ingestLegistar(locality, source, bad, ctx)).toEqual({ inserted: 0, skipped: 0 });
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
    expect(await ingestLegistar(locality, source, meta, ctx)).toEqual({ inserted: 0, skipped: 1 });
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
