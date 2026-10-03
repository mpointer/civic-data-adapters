// PDF blotter scraper for police departments that publish blotters as PDF files.
// Lazy-requires pdf-parse so it stays off the startup path and out of bundler
// static analysis.
//
// Source metadata: { provider: "blotter_pdf", url: "https://pd.example.gov/blotter.pdf" }
// Optional: { since?: "2024-01-01" } — skips incidents parsed before this date.
//
// Parsing strategy: looks for lines that start with a date pattern, then
// collects the following lines as the incident record until the next date.
// Works for the most common PDF blotter layout (date + type + location stacked).
import { createRequire } from "node:module";
import type {
  Locality,
  CivicSource,
  MetaFor,
  AdapterContext,
  AdapterResult,
  CivicRecord,
} from "../types.js";
import { ctxFetch, ctxUserAgent, robotsAllows } from "../internal.js";

const require = createRequire(import.meta.url);

const MAX_PAGES = 20;

// Matches common date patterns: "01/15/2025", "January 15, 2025", "2025-01-15"
const DATE_RE =
  /^(?:(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})|(\d{4})-(\d{2})-(\d{2})|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i;

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseIsoDate(raw: string): string | null {
  raw = raw.trim();
  // MM/DD/YYYY or MM-DD-YYYY
  let m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  // YYYY-MM-DD
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Month DD, YYYY
  m = raw.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (m) {
    const mo = MONTH_MAP[m[1]!.toLowerCase().slice(0, 3)];
    return `${m[3]}-${mo}-${m[2]!.padStart(2, "0")}`;
  }
  return null;
}

interface ParsedIncident {
  date: string | null;
  text: string;
}

export function extractIncidents(text: string): ParsedIncident[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const incidents: ParsedIncident[] = [];
  let current: { date: string | null; lines: string[] } | null = null;

  for (const line of lines) {
    if (DATE_RE.test(line)) {
      if (current) incidents.push({ date: current.date, text: current.lines.join(" ") });
      current = { date: parseIsoDate(line), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) incidents.push({ date: current.date, text: current.lines.join(" ") });
  return incidents;
}

export async function ingestPdfBlotter(
  locality: Locality,
  source: CivicSource,
  meta: MetaFor<"blotter_pdf">,
  ctx: AdapterContext
): Promise<AdapterResult> {
  const url = meta.url ?? source.url;
  if (!url) {
    await ctx.logger?.log(`[${locality.name}] blotter_pdf: no url in source metadata`, "warn");
    return { inserted: 0, skipped: 0 };
  }
  if (!(await robotsAllows(url, ctx))) {
    await ctx.logger?.log(
      `[${locality.name}] blotter_pdf: disallowed by robots.txt — skipping`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  let pdfText: string;
  try {
    const res = await ctxFetch(ctx)(url, { headers: { "User-Agent": ctxUserAgent(ctx) } });
    if (!res.ok) {
      await ctx.logger?.log(`[${locality.name}] blotter_pdf: HTTP ${res.status} from ${url}`, "warn");
      return { inserted: 0, skipped: 0 };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const pdfParse = require("pdf-parse") as (
      b: Buffer,
      o?: { max?: number }
    ) => Promise<{ text: string }>;
    const parsed = await pdfParse(buf, { max: MAX_PAGES });
    pdfText = parsed.text;
  } catch (err) {
    await ctx.logger?.log(`[${locality.name}] blotter_pdf: error — ${err}`, "warn");
    return { inserted: 0, skipped: 0 };
  }

  const incidents = extractIncidents(pdfText);
  if (!incidents.length) {
    await ctx.logger?.log(`[${locality.name}] blotter_pdf: no incidents parsed from ${url}`, "warn");
    return { inserted: 0, skipped: 0 };
  }

  const since = meta.since ?? null;
  const records: CivicRecord[] = [];

  for (let i = 0; i < incidents.length; i++) {
    const inc = incidents[i]!;
    if (since && inc.date && inc.date < since) continue;

    const firstLine = (inc.text.split(/\s{2,}|\n/)[0] ?? "").trim();
    const title = firstLine.slice(0, 120) || "Police incident";

    records.push({
      provider: "blotter_pdf",
      type: "police_blotter",
      title,
      summary: inc.text.length > title.length ? inc.text.slice(0, 500) : null,
      date: inc.date,
      url,
      // Positional key scoped by the PDF's URL (blotter PDFs are typically
      // dated files, so the URL already identifies the document).
      dedupeKey: `blotter_pdf:${url}:${i}:${inc.date ?? ""}`,
      localityName: locality.name,
      sourceId: source.id,
      raw: { rawText: inc.text.slice(0, 1000) },
    });
  }

  const result = await ctx.sink.save(records);
  await ctx.logger?.log(`[${locality.name}] blotter_pdf: +${result.inserted} incidents from ${url}`);
  return result;
}
