import { describe, it, expect, vi, afterEach } from "vitest";
import { ingestUSASpending } from "./usaspending.js";
import { MemorySink } from "../types.js";
import type { AdapterContext, Locality, CivicSource } from "../types.js";

// Regression test carried over from the original pipeline: fetchAwardGroup's
// while(true) pagination loop shared the exact same unbounded shape as the
// nonprofit adapter's production bug (no per-fetch timeout, no page cap, no
// time budget). It never actually timed out in production —
// place_of_performance is a real structured filter, unlike Nonprofit
// Explorer's fuzzy text search — but it got the same defensive guard in the
// same fix. This verifies that guard.

const locality: Locality = { name: "Pittsburgh", state: "PA" };
const source: CivicSource = { id: 1 };

function makeCtx(fetchMock: ReturnType<typeof vi.fn>) {
  const log = vi.fn();
  const ctx: AdapterContext = {
    sink: new MemorySink(),
    logger: { log },
    fetch: fetchMock as unknown as typeof fetch,
  };
  return { ctx, log };
}

describe("ingestUSASpending pagination guard (unbounded-pagination timeout bug)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps pagination at MAX_PAGES when the API keeps reporting a next page", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [],
        page_metadata: { page: 1, total: 100000, has_next_page: true },
      }),
    });
    const { ctx, log } = makeCtx(fetchMock);

    const promise = ingestUSASpending(
      locality,
      source,
      { provider: "usaspending", awardTypes: "contracts" },
      ctx
    );
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(50); // MAX_PAGES
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("hit page cap"), "warn");
  });

  it("stops early once the time budget is exceeded, even when under the page cap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => {
      vi.advanceTimersByTime(70_000); // simulate one very slow request
      return {
        ok: true,
        json: async () => ({
          results: [],
          page_metadata: { page: 1, total: 3, has_next_page: true },
        }),
      };
    });
    const { ctx, log } = makeCtx(fetchMock);

    const promise = ingestUSASpending(
      locality,
      source,
      { provider: "usaspending", awardTypes: "contracts" },
      ctx
    );
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("time budget reached"), "warn");
  });

  it("finishes normally without cap/budget warnings once has_next_page is false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [],
        page_metadata: { page: 1, total: 0, has_next_page: false },
      }),
    });
    const { ctx, log } = makeCtx(fetchMock);

    await ingestUSASpending(
      locality,
      source,
      { provider: "usaspending", awardTypes: "contracts" },
      ctx
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("hit page cap"), "warn");
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("time budget reached"), "warn");
  });
});
