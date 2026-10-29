import { describe, it, expect, vi, afterEach } from "vitest";
import { ingestNonprofitExplorer, nonprofitDedupeKey } from "./nonprofit.js";
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
    expect(result).toMatchObject({ inserted: 0, skipped: 0 });
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

describe("ingestNonprofitExplorer malformed responses", () => {
  const meta = { provider: "nonprofit_explorer" } as const;
  const org = (over: Record<string, unknown> = {}) => ({
    ein: 123456789,
    name: "Friends of the Library",
    city: "Pittsburgh",
    state: "PA",
    ntee_code: "B20",
    income_amount: 5000,
    asset_amount: 10000,
    filing_date: new Date().toISOString().slice(0, 10),
    form_type: "990",
    ...over,
  });
  const mk = (body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const log = vi.fn();
    const sink = new MemorySink();
    const ctx: AdapterContext = { sink, logger: { log }, fetch: fetchMock as unknown as typeof fetch, skipRobotsCheck: true };
    return { ctx, sink, log };
  };
  const loc: Locality = { name: "Pittsburgh", state: "PA" };

  it("does not throw when organizations is missing; warns and stops", async () => {
    const { ctx, log } = mk({ error: "rate limited" });
    await expect(ingestNonprofitExplorer(loc, { id: 1 }, meta, ctx)).resolves.toMatchObject({ inserted: 0, skipped: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("unexpected response shape"), "warn");
  });

  it("skips orgs with no ein or name instead of keying them 'undefined'", async () => {
    const { ctx, sink, log } = mk({
      num_pages: 1,
      organizations: [org({ ein: undefined }), org({ ein: null }), org({ name: null, ein: 5 }), org({ ein: 42 }), "junk"],
    });
    await ingestNonprofitExplorer(loc, { id: 1 }, meta, ctx);
    expect([...sink.records.keys()]).toEqual(["propublica:nonprofit:42"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped 4 malformed org"), "warn");
  });

  it("accepts numeric or string eins, preserving the raw value", async () => {
    const { ctx, sink } = mk({ num_pages: 1, organizations: [org({ ein: 7 }), org({ ein: "000000008" })] });
    await ingestNonprofitExplorer(loc, { id: 1 }, meta, ctx);
    expect([...sink.records.keys()].sort()).toEqual(["propublica:nonprofit:000000008", "propublica:nonprofit:7"]);
    expect(sink.records.get("propublica:nonprofit:7")?.raw).toMatchObject({ ein: 7 });
  });

  describe("dedupe key follows the filing, not just the organization", () => {
    it("adds a new record when an organization files for a new period", async () => {
      const sink = new MemorySink();
      const run = async (period: unknown, income: number) => {
        const { ctx } = mk({ num_pages: 1, organizations: [org({ tax_period: period, income_amount: income })] });
        return ingestNonprofitExplorer(loc, { id: 1 }, meta, { ...ctx, sink });
      };
      expect(await run(202212, 5000)).toMatchObject({ inserted: 1, skipped: 0 });
      expect(await run(202312, 7000)).toMatchObject({ inserted: 1, skipped: 0 });
      expect(await run(202312, 7000)).toMatchObject({ inserted: 0, skipped: 1 }); // same filing again: no-op
      expect([...sink.records.keys()].sort()).toEqual(["propublica:nonprofit:123456789:202212", "propublica:nonprofit:123456789:202312"]);
      expect(sink.records.get("propublica:nonprofit:123456789:202312")?.raw).toMatchObject({ taxPeriod: "202312", incomeAmount: 7000 });
    });

    it("keeps the EIN-only key when the response carries no tax period", async () => {
      const { ctx, sink } = mk({ num_pages: 1, organizations: [org()] });
      await ingestNonprofitExplorer(loc, { id: 1 }, meta, ctx);
      expect([...sink.records.keys()]).toEqual(["propublica:nonprofit:123456789"]);
    });

    it("exposes the key so consumers can find rows to migrate", () => {
      expect(nonprofitDedupeKey(123456789, "202312")).toBe("propublica:nonprofit:123456789:202312");
      expect(nonprofitDedupeKey("000000008", null)).toBe("propublica:nonprofit:000000008");
    });
  });

  it("tolerates a missing num_pages by treating it as a single page", async () => {
    const { ctx, sink } = mk({ organizations: [org()] });
    await ingestNonprofitExplorer(loc, { id: 1 }, meta, ctx);
    expect(sink.records.size).toBe(1);
  });
});
