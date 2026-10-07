import { describe, it, expect, vi } from "vitest";
import { ingestHtmlBlotter, parseBlotterHtml, parseHtmlTables, extractRowsFromTable } from "./blotter-html.js";
import { MemorySink } from "../types.js";
import type { AdapterContext } from "../types.js";

// SYNTHETIC fixtures modeled on common municipal blotter layouts — NOT
// captured from live sites. They pin parser behavior, but real-page markup
// drift (the likely breakage) still needs recorded fixtures.
const BASIC = `
<html><body>
<table><tr><td>nav</td></tr></table>
<table class="blotter">
  <thead><tr><th>Date</th><th>Offense</th><th>Location</th><th>Narrative</th><th>Case #</th></tr></thead>
  <tbody>
    <tr><td>03/04/2026</td><td>Theft &amp; Larceny</td><td>100 Main St</td><td>Bike taken from <b>rack</b></td><td>26-0001</td></tr>
    <tr><td>3-5-26</td><td>Disturbance</td><td>200 Oak Ave</td><td></td><td></td></tr>
    <tr><td>2026-03-06T10:00:00</td><td>DUI</td><td>Route 8</td><td>Stop</td><td>26-0003</td></tr>
  </tbody>
</table>
</body></html>`;

// No <th> semantics and columns in a non-default order; needs overrides.
const REORDERED = `
<table>
  <tr><td>Col A</td><td>Col B</td><td>Col C</td></tr>
  <tr><td>Burglary</td><td>9 Elm St</td><td>03/09/2026</td></tr>
</table>`;

describe("parseHtmlTables", () => {
  it("ignores single-row tables, strips tags, collapses whitespace", () => {
    const tables = parseHtmlTables(BASIC);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.[1]).toEqual(["03/04/2026", "Theft &amp; Larceny", "100 Main St", "Bike taken from rack", "26-0001"]);
  });

  it("returns [] for markup with no tables", () => {
    expect(parseHtmlTables("<div>No blotter today</div>")).toEqual([]);
  });
});

describe("parseBlotterHtml", () => {
  it("guesses columns from headers and normalizes dates", () => {
    const rows = parseBlotterHtml(BASIC);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ date: "2026-03-04", type: "Theft &amp; Larceny", location: "100 Main St", caseNumber: "26-0001" });
    expect(rows[1]).toMatchObject({ date: "2026-03-05", description: "", caseNumber: "" });
    expect(rows[2]?.date).toBe("2026-03-06"); // ISO timestamp passes through
  });

  it("falls back to empty fields when headers are unrecognizable, and honors overrides", () => {
    const guessed = parseBlotterHtml(REORDERED);
    expect(guessed[0]).toMatchObject({ date: null, type: "", location: "" });
    const fixed = parseBlotterHtml(REORDERED, { typeCol: 0, locCol: 1, dateCol: 2 });
    expect(fixed[0]).toMatchObject({ date: "2026-03-09", type: "Burglary", location: "9 Elm St" });
  });

  it("picks the largest table, not the first", () => {
    expect(parseBlotterHtml(BASIC)[0]?.location).toBe("100 Main St");
  });
});

describe("extractRowsFromTable", () => {
  it("returns [] for header-only tables and caps at 500 rows", () => {
    expect(extractRowsFromTable([["Date"]], {})).toEqual([]);
    const big = [["Date", "Offense"], ...Array.from({ length: 600 }, (_, i) => [`01/01/2026`, `o${i}`])];
    expect(extractRowsFromTable(big, {})).toHaveLength(500);
  });
});

function setup(html: string | Response) {
  const sink = new MemorySink();
  const log = vi.fn();
  const fetchMock = vi.fn(async () => (typeof html === "string" ? new Response(html) : html));
  const ctx: AdapterContext = { sink, logger: { log }, fetch: fetchMock as unknown as typeof fetch, skipRobotsCheck: true };
  return { ctx, sink, log, fetchMock };
}
const locality = { name: "Exampleville" };
const source = { id: 3 };

describe("ingestHtmlBlotter", () => {
  it("ingests rows with case-number and positional dedupe keys", async () => {
    const { ctx, sink } = setup(BASIC);
    const r = await ingestHtmlBlotter(locality, source, { provider: "blotter_html", url: "https://pd.example.gov/b" }, ctx);
    expect(r).toEqual({ inserted: 3, skipped: 0 });
    const keys = [...sink.records.keys()];
    expect(keys).toContain("blotter_html:Exampleville:26-0001");
    expect(keys).toContain("blotter_html:https://pd.example.gov/b:1:2026-03-05"); // no case number
    expect(sink.records.get("blotter_html:Exampleville:26-0001")).toMatchObject({
      type: "police_blotter",
      title: "Theft &amp; Larceny — 100 Main St",
      summary: "Bike taken from rack",
      date: "2026-03-04",
    });
  });

  it("uses source.url when meta has none, and warns when neither exists", async () => {
    const { ctx, fetchMock, log } = setup(BASIC);
    await ingestHtmlBlotter(locality, { id: 1, url: "https://pd.example.gov/s" }, { provider: "blotter_html" }, ctx);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://pd.example.gov/s");
    await ingestHtmlBlotter(locality, source, { provider: "blotter_html" }, ctx);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no url"), "warn");
  });

  it("returns zeros on HTTP errors, network errors, and table-less pages", async () => {
    const meta = { provider: "blotter_html", url: "https://pd.example.gov/b" } as const;
    expect(await ingestHtmlBlotter(locality, source, meta, setup(new Response("", { status: 503 })).ctx)).toEqual({ inserted: 0, skipped: 0 });
    expect(await ingestHtmlBlotter(locality, source, meta, setup("<p>JS-rendered page</p>").ctx)).toEqual({ inserted: 0, skipped: 0 });
    const { ctx } = setup("");
    ctx.fetch = (async () => {
      throw new Error("dns");
    }) as unknown as typeof fetch;
    expect(await ingestHtmlBlotter(locality, source, meta, ctx)).toEqual({ inserted: 0, skipped: 0 });
  });

  it("respects robots.txt disallow", async () => {
    const { ctx, sink } = setup(BASIC);
    ctx.skipRobotsCheck = false;
    ctx.fetch = (async (u: unknown) =>
      String(u).endsWith("/robots.txt")
        ? new Response("User-agent: *\nDisallow: /blotter")
        : new Response(BASIC)) as unknown as typeof fetch;
    const r = await ingestHtmlBlotter(locality, source, { provider: "blotter_html", url: "https://robots-block.example.gov/blotter" }, ctx);
    expect(r).toEqual({ inserted: 0, skipped: 0 });
    expect(sink.records.size).toBe(0);
  });
});
