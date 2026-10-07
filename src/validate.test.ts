import { describe, it, expect } from "vitest";
import { parseAdapterMeta, parseMinutesItems, extractJsonArray } from "./validate.js";

describe("parseAdapterMeta", () => {
  it("accepts a valid legistar meta and narrows the type", () => {
    const r = parseAdapterMeta({ provider: "legistar", clientId: "seattle", since: "2026-01-01" });
    expect(r).toEqual({ ok: true, value: { provider: "legistar", clientId: "seattle", since: "2026-01-01" } });
  });

  it("rejects a missing required field", () => {
    const r = parseAdapterMeta({ provider: "legistar" });
    expect(r).toEqual({ ok: false, error: "legistar.clientId is required" });
  });

  it("requires url and resourceId for socrata", () => {
    expect(parseAdapterMeta({ provider: "socrata", url: "https://data.example.gov" }).ok).toBe(false);
    expect(
      parseAdapterMeta({ provider: "socrata", url: "https://data.example.gov", resourceId: "abcd-1234" }).ok
    ).toBe(true);
  });

  it("rejects wrong-typed fields", () => {
    const r = parseAdapterMeta({ provider: "usaspending", lookbackDays: "30" });
    expect(r).toEqual({ ok: false, error: "usaspending.lookbackDays: expected a finite number" });
  });

  it("rejects out-of-set enum values", () => {
    const r = parseAdapterMeta({ provider: "usaspending", awardTypes: "everything" });
    expect(r.ok).toBe(false);
    expect(parseAdapterMeta({ provider: "socrata", url: "u", resourceId: "r", recordType: "nope" }).ok).toBe(false);
  });

  it("rejects non-string arrays", () => {
    const r = parseAdapterMeta({ provider: "socrata", url: "u", resourceId: "r", titleFields: ["a", 1] });
    expect(r.ok).toBe(false);
  });

  it("drops fields that belong to other providers and treats null as absent", () => {
    const r = parseAdapterMeta({ provider: "legistar", clientId: "x", nteeFilter: "A", since: null });
    expect(r).toEqual({ ok: true, value: { provider: "legistar", clientId: "x" } });
  });

  it("rejects unknown providers, including prototype keys", () => {
    expect(parseAdapterMeta({ provider: "carrier_pigeon" }).ok).toBe(false);
    expect(parseAdapterMeta({ provider: "toString" }).ok).toBe(false);
    expect(parseAdapterMeta({}).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    for (const v of [null, undefined, "legistar", 5, [], [{ provider: "legistar" }]]) {
      expect(parseAdapterMeta(v).ok).toBe(false);
    }
  });

  it("accepts stub providers", () => {
    expect(parseAdapterMeta({ provider: "granicus", url: "https://x.granicus.com" }).ok).toBe(true);
  });
});

describe("extractJsonArray", () => {
  it("parses bare, fenced, and prose-wrapped arrays", () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('Sure! Here you go: [{"a":1}] hope that helps')).toEqual([{ a: 1 }]);
  });

  it("returns null for non-arrays and garbage", () => {
    expect(extractJsonArray('{"a":1}')).toBeNull();
    expect(extractJsonArray("no json here")).toBeNull();
    expect(extractJsonArray("")).toBeNull();
  });

  it("returns [] for a valid empty array", () => {
    expect(extractJsonArray("[]")).toEqual([]);
  });
});

describe("parseMinutesItems", () => {
  it("validates and coerces items", () => {
    const raw = JSON.stringify([
      { title: "  Approve budget ", action: "Voted", result: "Approved 5-2", date: "2026-03-04" },
      { title: "Tabled item", action: null, result: 7, date: "March 4" },
    ]);
    const r = parseMinutesItems(raw);
    expect(r).toEqual({
      ok: true,
      value: {
        dropped: 0,
        items: [
          { title: "Approve budget", action: "Voted", result: "Approved 5-2", date: "2026-03-04" },
          { title: "Tabled item", action: null, result: null, date: null },
        ],
      },
    });
  });

  it("drops entries without a usable title and counts them", () => {
    const r = parseMinutesItems(JSON.stringify([{ title: "ok" }, { title: "" }, { action: "x" }, null, "str", 3]));
    expect(r.ok && r.value.items.map((i) => i.title)).toEqual(["ok"]);
    expect(r.ok && r.value.dropped).toBe(5);
  });

  it("distinguishes no-JSON from an empty array", () => {
    expect(parseMinutesItems("I could not find any items.").ok).toBe(false);
    expect(parseMinutesItems("[]")).toEqual({ ok: true, value: { items: [], dropped: 0 } });
  });
});
