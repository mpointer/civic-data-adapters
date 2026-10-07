import { describe, it, expect, vi } from "vitest";
import { ingestSocrataRecords } from "./blotter-socrata.js";
import { MemorySink } from "../types.js";
import type { AdapterContext, MetaFor } from "../types.js";

const locality = { name: "Exampleville" };
const source = { id: 5 };
const future = new Date(Date.now() + 900 * 86_400_000).toISOString().slice(0, 10);

function setup(pages: unknown[][]) {
  const sink = new MemorySink();
  const log = vi.fn();
  let i = 0;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(pages[i++] ?? [])));
  const ctx: AdapterContext = { sink, logger: { log }, fetch: fetchMock as unknown as typeof fetch };
  return { ctx, sink, log, fetchMock };
}
const blotterMeta: MetaFor<"socrata"> = { provider: "socrata", url: "https://data.example.gov/", resourceId: "abcd-1234" };

describe("ingestSocrataRecords", () => {
  it("rejects stored meta missing url/resourceId at runtime", async () => {
    const { ctx, fetchMock, log } = setup([]);
    const bad = { provider: "socrata", url: "https://data.example.gov" } as unknown as MetaFor<"socrata">;
    expect(await ingestSocrataRecords(locality, source, bad, ctx)).toEqual({ inserted: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("missing url or resourceId"), "warn");
  });

  it("builds the endpoint with $where/$limit/$offset and strips the trailing slash", async () => {
    const { ctx, fetchMock } = setup([[]]);
    await ingestSocrataRecords(locality, source, { ...blotterMeta, since: "2026-01-01", dateField: "incident_date" }, ctx);
    const url = decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]));
    expect(url).toContain("https://data.example.gov/resource/abcd-1234.json?");
    expect(url).toContain("incident_date");
    expect(url).toContain("2026-01-01");
    expect(url).toContain("$limit=1000");
  });

  it("maps blotter rows using default and overridden field names", async () => {
    const rows = [
      { date: "2026-03-04T12:00:00.000", offense_type: "Burglary", block_address: "100 Block Main", report_number: "R-1", description: "Forced entry" },
      { date: future, offense_type: "Typo date", report_number: "R-2" },
    ];
    const { ctx, sink } = setup([rows]);
    const r = await ingestSocrataRecords(locality, source, blotterMeta, ctx);
    expect(r.inserted).toBe(2);
    expect(sink.records.get("socrata:abcd-1234:R-1")).toMatchObject({
      type: "police_blotter",
      title: "Burglary — 100 Block Main",
      summary: "Forced entry",
      date: "2026-03-04",
      location: "100 Block Main",
      caseNumber: "R-1",
    });
    expect(sink.records.get("socrata:abcd-1234:R-2")?.date).toBeNull(); // future date sanitized
  });

  it("uses a positional key when a row has no case number", async () => {
    const { ctx, sink } = setup([[{ date: "2026-03-04", offense_type: "Noise" }]]);
    await ingestSocrataRecords(locality, source, blotterMeta, ctx);
    expect([...sink.records.keys()]).toEqual(["socrata:abcd-1234:abcd-1234:0"]);
  });

  it("supports generic record types with titleFields/summaryFields/amountField", async () => {
    const rows = [{ issued_date: "2026-02-01", permit_number: "P-9", permit_type: "Roofing", applicant_name: "Acme", notes: "Re-roof", fee: "125" }];
    const { ctx, sink } = setup([rows]);
    await ingestSocrataRecords(
      locality,
      source,
      { ...blotterMeta, recordType: "permit", dateField: "issued_date", caseField: "permit_number", titleFields: ["permit_type", "applicant_name"], summaryFields: ["notes"], amountField: "fee" },
      ctx
    );
    expect(sink.records.get("socrata:abcd-1234:P-9")).toMatchObject({
      type: "permit",
      title: "Roofing — Acme",
      summary: "Re-roof",
      date: "2026-02-01",
      raw: { amount: "125", caseNumber: "P-9" },
    });
  });

  it("pages until a short page and stops at maxPages with a warning", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ date: "2026-03-01", report_number: `n${i}` }));
    const { ctx, fetchMock } = setup([full, [{ date: "2026-03-01", report_number: "last" }]]);
    await ingestSocrataRecords(locality, source, blotterMeta, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const capped = setup([full, full, full]);
    await ingestSocrataRecords(locality, source, { ...blotterMeta, maxPages: 2 }, capped.ctx);
    expect(capped.fetchMock).toHaveBeenCalledTimes(2);
    expect(capped.log).toHaveBeenCalledWith(expect.stringContaining("page cap"), "warn");
  });

  it("keeps what it has and stops on an HTTP error mid-stream", async () => {
    const sink = new MemorySink();
    const full = Array.from({ length: 1000 }, (_, i) => ({ date: "2026-03-01", report_number: `n${i}` }));
    let call = 0;
    const ctx: AdapterContext = {
      sink,
      fetch: (async () => (call++ === 0 ? new Response(JSON.stringify(full)) : new Response("", { status: 500 }))) as unknown as typeof fetch,
    };
    const r = await ingestSocrataRecords(locality, source, blotterMeta, ctx);
    expect(r.inserted).toBe(1000);
  });
});
