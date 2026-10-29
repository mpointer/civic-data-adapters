import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ingestHtmlMinutes } from "./html-minutes.js";
import { extractIncidents, ingestPdfBlotter } from "./blotter-pdf.js";
import { MemorySink } from "../types.js";
import type { AdapterContext } from "../types.js";

// SYNTHETIC text shaped like pdf-parse output for a stacked-layout blotter.
// Not captured from a real department's PDF.
const TEXT = `
Exampleville Police Department
Daily Activity Log

03/04/2026 0912 Theft
100 Main St
Bike taken from rack
March 5, 2026 Disturbance
200 Oak Ave
2026-03-06 DUI
Route 8
`;

describe("extractIncidents", () => {
  it("splits on date-led lines across all three date formats and ignores the preamble", () => {
    const inc = extractIncidents(TEXT);
    expect(inc.map((i) => i.date)).toEqual(["2026-03-04", "2026-03-05", "2026-03-06"]);
    expect(inc[0]?.text).toBe("03/04/2026 0912 Theft 100 Main St Bike taken from rack");
  });

  it("returns [] when no line starts with a date", () => {
    expect(extractIncidents("Just a header\nand some prose")).toEqual([]);
    expect(extractIncidents("")).toEqual([]);
  });

  it("zero-pads and expands two-digit years", () => {
    expect(extractIncidents("3/4/26 Noise")[0]?.date).toBe("2026-03-04");
  });
});

describe("ingestPdfBlotter", () => {
  it("warns on missing url, robots denial, and HTTP errors", async () => {
    const log = vi.fn();
    const sink = new MemorySink();
    const base: AdapterContext = { sink, logger: { log }, skipRobotsCheck: true };
    await ingestPdfBlotter({ name: "X" }, { id: 1 }, { provider: "blotter_pdf" }, base);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no url"), "warn");

    const http500 = { ...base, fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch };
    expect(await ingestPdfBlotter({ name: "X" }, { id: 1 }, { provider: "blotter_pdf", url: "https://p.example.gov/b.pdf" }, http500)).toMatchObject({ inserted: 0, skipped: 0 });

    const denied: AdapterContext = {
      sink,
      skipRobotsCheck: false,
      fetch: (async (u: unknown) =>
        String(u).endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /") : new Response("")) as unknown as typeof fetch,
    };
    expect(await ingestPdfBlotter({ name: "X" }, { id: 1 }, { provider: "blotter_pdf", url: "https://pdf-denied.example.gov/b.pdf" }, denied)).toMatchObject({ inserted: 0, skipped: 0 });
  });

  it("returns zeros (not a throw) when the bytes aren't a parseable PDF", async () => {
    const ctx: AdapterContext = {
      sink: new MemorySink(),
      skipRobotsCheck: true,
      fetch: (async () => new Response("this is not a pdf")) as unknown as typeof fetch,
    };
    expect(await ingestPdfBlotter({ name: "X" }, { id: 1 }, { provider: "blotter_pdf", url: "https://p.example.gov/b.pdf" }, ctx)).toMatchObject({ inserted: 0, skipped: 0 });
  });
});

describe("with a real PDF through the isolated parser", () => {
  const pdf = new Uint8Array(readFileSync(new URL("../test-data/three-pages.pdf", import.meta.url)));
  const ctxFor = (extra: Partial<AdapterContext> = {}): AdapterContext => ({
    sink: new MemorySink(),
    skipRobotsCheck: true,
    // a fresh Response per call: the adapter may fetch the same URL more than once
    fetch: (async () => new Response(pdf, { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch,
    ...extra,
  });

  it("ingests a blotter PDF end to end", async () => {
    const ctx = ctxFor();
    const r = await ingestPdfBlotter({ name: "X" }, { id: 1 }, { provider: "blotter_pdf", url: "https://p.example.gov/b.pdf" }, ctx);
    expect(r).toMatchObject({ status: "ok", inserted: 4 });
    expect([...(ctx.sink as MemorySink).records.values()].map((x) => x.date)).toEqual(["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07"]);
  });

  it("feeds a PDF agenda to html_minutes", async () => {
    const reply = JSON.stringify([{ title: "Vandalism at 300 Elm St" }]);
    const ctx = ctxFor({ summarize: async () => reply });
    const r = await ingestHtmlMinutes({ name: "X" }, { id: 1 }, { provider: "html_minutes", url: "https://m.example.gov/agenda.pdf" }, ctx);
    expect(r).toMatchObject({ status: "ok", inserted: 1 });
  });
});
