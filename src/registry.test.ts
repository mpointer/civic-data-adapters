import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { sanitizeCivicDate, runAdapter } from "./registry.js";
import { MemorySink } from "./types.js";
import type { CivicAdapterMeta } from "./types.js";

// Regression test from the original pipeline: a state kennel-inspection row
// arrived dated nearly two years in the future because the Socrata adapter
// trusted whatever string the source field held. The record date drives
// "recent activity" views downstream, so an unvalidated future date isn't
// cosmetic.
describe("sanitizeCivicDate", () => {
  it("passes through a plausible past/present date", () => {
    expect(sanitizeCivicDate("2026-01-15")).toBe("2026-01-15");
  });

  it("truncates a full timestamp to the date portion", () => {
    expect(sanitizeCivicDate("2026-01-15T09:30:00.000Z")).toBe("2026-01-15");
  });

  it("rejects a date more than a year in the future", () => {
    const farFuture = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    expect(sanitizeCivicDate(farFuture)).toBeNull();
  });

  it("allows a date within the next year (e.g. a scheduled hearing)", () => {
    const nearFuture = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(sanitizeCivicDate(nearFuture)).toBe(nearFuture);
  });

  it("returns null for empty, null, or unparseable input", () => {
    expect(sanitizeCivicDate(null)).toBeNull();
    expect(sanitizeCivicDate(undefined)).toBeNull();
    expect(sanitizeCivicDate("")).toBeNull();
    expect(sanitizeCivicDate("not-a-date")).toBeNull();
  });
});

describe("runAdapter dispatch", () => {
  const locality = { name: "Exampleville" };
  const mk = (fetchMock = vi.fn(async () => new Response("[]"))) => {
    const log = vi.fn();
    return {
      log,
      fetchMock,
      ctx: { sink: new MemorySink(), logger: { log }, fetch: fetchMock as unknown as typeof fetch, skipRobotsCheck: true },
    };
  };

  it("routes by provider", async () => {
    const { ctx, fetchMock } = mk();
    await runAdapter(locality, { id: 1 }, { provider: "legistar", clientId: "ex" }, ctx);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("webapi.legistar.com/v1/ex/Events");
  });

  it("treats a missing provider as legistar (legacy stored metadata)", async () => {
    const { ctx, fetchMock } = mk();
    await runAdapter(locality, { id: 1 }, { clientId: "ex" } as unknown as CivicAdapterMeta, ctx);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("webapi.legistar.com/v1/ex/Events");
  });

  it("skips unknown providers with a warning instead of throwing", async () => {
    const { ctx, log, fetchMock } = mk();
    const r = await runAdapter(locality, { id: 9 }, { provider: "carrier_pigeon" } as unknown as CivicAdapterMeta, ctx);
    expect(r).toEqual({ inserted: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("unknown provider 'carrier_pigeon'"), "warn");
  });

  it.each(["granicus", "civicplus", "boarddocs"] as const)("%s is a logged no-op stub", async (provider) => {
    const { ctx, log, fetchMock } = mk();
    expect(await runAdapter(locality, { id: 1 }, { provider }, ctx)).toEqual({ inserted: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`${provider}: no public API`), "warn");
  });
});
