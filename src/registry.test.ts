import { describe, it, expect } from "vitest";
import { sanitizeCivicDate } from "./registry.js";

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
