import { describe, it, expect, vi, afterEach } from "vitest";
import { ingestNonprofitExplorer } from "./nonprofit.js";
import { MemorySink } from "../types.js";
import type { AdapterContext, Locality, CivicSource } from "../types.js";

// Regression test carried over from the original pipeline: ProPublica's `q`
// param is a nationwide fuzzy text search with no working server-side state
// filter (confirmed live 2026-07-15 — `state.id` is silently ignored,
// `selected_state` stays null, and num_pages/total_results are identical
// with or without it). A common city name reports num_pages in the hundreds,
// and walking all of them with no per-fetch timeout stranded several
// localities' scheduled runs past a 300-second serverless execution cap in
// production. This verifies the fix: a hard page cap, a wall-clock time
// budget, and a per-fetch timeout signal.

const locality: Locality = { name: "Pittsburgh", state: "PA" };
const source: CivicSource = { id: 1 };

function makeCtx(fetchMock: ReturnType<typeof vi.fn>) {
  const log = vi.fn();
  const ctx: AdapterContext = {
    sink: new MemorySink(),
    logger: { log },
    fetch: fetchMock as unknown as typeof fetch,
    skipRobotsCheck: true,
  };
  return { ctx, log };
}

describe("ingestNonprofitExplorer pagination guard (unbounded-pagination timeout bug)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps pagination at MAX_PAGES when the API reports far more pages than that", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_results: 10000,
        num_pages: 400,
        cur_page: 0,
        organizations: [],
      }),
    });
    const { ctx, log } = makeCtx(fetchMock);

    const promise = ingestNonprofitExplorer(
      locality,
      source,
      { provider: "nonprofit_explorer" },
      ctx
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(20); // MAX_PAGES
    expect(result).toEqual({ inserted: 0, skipped: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("hit page cap"), "warn");
  });

  it("passes a per-fetch abort signal so a hung request can't block the loop forever", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total_results: 0, num_pages: 1, cur_page: 0, organizations: [] }),
    });
    const { ctx } = makeCtx(fetchMock);

    const promise = ingestNonprofitExplorer(
      locality,
      source,
      { provider: "nonprofit_explorer" },
      ctx
    );
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("stops early once the time budget is exceeded, even when under the page cap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => {
      vi.advanceTimersByTime(70_000); // simulate one very slow request
      return {
        ok: true,
        json: async () => ({ total_results: 3, num_pages: 5, cur_page: 0, organizations: [] }),
      };
    });
    const { ctx, log } = makeCtx(fetchMock);

    const promise = ingestNonprofitExplorer(
      locality,
      source,
      { provider: "nonprofit_explorer" },
      ctx
    );
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1); // budget trips before a 2nd page fetch
    expect(log).toHaveBeenCalledWith(expect.stringContaining("time budget reached"), "warn");
  });

  it("finishes normally without any cap/budget warnings when pagination is small and fast", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total_results: 0, num_pages: 1, cur_page: 0, organizations: [] }),
    });
    const { ctx, log } = makeCtx(fetchMock);

    await ingestNonprofitExplorer(locality, source, { provider: "nonprofit_explorer" }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("hit page cap"), "warn");
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("time budget reached"), "warn");
  });
});
