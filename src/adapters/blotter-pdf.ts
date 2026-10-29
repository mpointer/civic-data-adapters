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
import { ctxFetch, ctxUserAgent, robotsAllows, FETCH_TIMEOUT_MS } from "../internal.js";
import { createRun } from "../outcome.js";
import { contentKey } from "../dedupe.js";

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

export interface ParsedIncident {
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

export interface PdfRecordOptions {
  url: string;
  locality: Locality;
  source: CivicSource;
  /** Skip incidents dated before this ISO date. */
  since?: string | undefined;
}

/** Turn parsed incidents into records. Pure, so it can be tested without a PDF. */
export function pdfIncidentRecords(incidents: ParsedIncident[], opts: PdfRecordOptions): CivicRecord[] {
  const { url, locality, source } = opts;
  const since = opts.since ?? null;
  const records: CivicRecord[] = [];
  const seen = new Map<string, number>();

  for (const inc of incidents) {
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
      // Content key, scoped to the locality (not the URL): blotters list newest
      // first, so a positional key shifted on every update and re-inserted old
      // incidents, and a URL-scoped key would duplicate across a rotating filename.
      dedupeKey: `blotter_pdf:${locality.name}:${contentKey([inc.date, inc.text], seen)}`,
      localityName: locality.name,
      sourceId: source.id,
      raw: { rawText: inc.text.slice(0, 1000) },
    });
  }
  return records;
}

export async function ingestPdfBlotter(
  locality: Locality,
  source: CivicSource,
  meta: MetaFor<"blotter_pdf">,
  ctx: AdapterContext
): Promise<AdapterResult> {
  const run = createRun(ctx, `[${locality.name}] blotter_pdf:`);
  const url = meta.url ?? source.url;
  if (!url) return run.fail("no url in source metadata");
  if (!(await robotsAllows(url, ctx))) return run.skip("disallowed by robots.txt — skipping");

  let pdfText: string;
  try {
    const res = await ctxFetch(ctx)(url, {
      headers: { "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return run.fail(`HTTP ${res.status} from ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const pdfParse = require("pdf-parse") as (
      b: Buffer,
      o?: { max?: number }
    ) => Promise<{ text: string; numpages?: number }>;
    const parsed = await pdfParse(buf, { max: MAX_PAGES });
    pdfText = parsed.text;
    if (typeof parsed.numpages === "number" && parsed.numpages > MAX_PAGES) {
      await run.problem(`PDF has ${parsed.numpages} pages; only the first ${MAX_PAGES} were read`);
    }
  } catch (err) {
    return run.fail(`error — ${err}`);
  }

  const incidents = extractIncidents(pdfText);
  if (!incidents.length) return run.fail(`no incidents parsed from ${url}`);

  const records = pdfIncidentRecords(incidents, { url, locality, source, since: meta.since });

  const result = await ctx.sink.save(records);
  await ctx.logger?.log(`[${locality.name}] blotter_pdf: +${result.inserted} incidents from ${url}`);
  return run.done(result, records.length);
}
