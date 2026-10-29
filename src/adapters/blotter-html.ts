// HTML scraper for police blotter pages that don't have a Socrata/open-data feed.
// Fetches the blotter URL, walks the DOM for table rows, and hands results to
// the sink with type="police_blotter".
//
// Source metadata: { provider: "blotter_html", url: "https://pd.example.gov/blotter" }
// Optional column overrides: { dateCol?: 0, typeCol?: 1, locCol?: 2, descCol?: 3, caseCol?: 4 }
import type {
  Locality,
  CivicSource,
  MetaFor,
  AdapterContext,
  AdapterResult,
  CivicRecord,
} from "../types.js";
import { ctxUserAgent, robotsAllows, FETCH_TIMEOUT_MS, safeFetch } from "../internal.js";
import { contentKey } from "../dedupe.js";
import { createRun } from "../outcome.js";
import { parseHtmlTables } from "../html.js";
import { readText, MAX_HTML_BYTES } from "../body.js";

const MAX_ROWS = 500;

interface BlotterRow {
  date: string | null;
  type: string;
  location: string;
  description: string;
  caseNumber: string;
}

function parseIsoDate(raw: string): string | null {
  if (!raw) return null;
  const clean = raw.trim();
  // ISO first: the m/d/y pattern below would otherwise match the tail of
  // "2026-03-06" as "26-03-06" and return garbage like "2006-26-03".
  const isoMatch = clean.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1]!;
  const m = clean.match(/(?<!\d)(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  return null;
}

export { parseHtmlTables };

function guessColumn(headers: string[], candidates: string[]): number {
  for (const cand of candidates) {
    const idx = headers.findIndex((h) => h.toLowerCase().includes(cand.toLowerCase()));
    if (idx >= 0) return idx;
  }
  return -1;
}

interface ColOverrides {
  dateCol?: number;
  typeCol?: number;
  locCol?: number;
  descCol?: number;
  caseCol?: number;
}

export function extractRowsFromTable(
  table: string[][],
  metaOverrides: ColOverrides
): BlotterRow[] {
  if (table.length < 2) return [];
  const headers = (table[0] ?? []).map((h) => h.toLowerCase());

  const dateCol = metaOverrides.dateCol ?? guessColumn(headers, ["date", "occurred", "reported"]);
  const typeCol = metaOverrides.typeCol ?? guessColumn(headers, ["offense", "type", "crime", "call", "charge"]);
  const locCol = metaOverrides.locCol ?? guessColumn(headers, ["location", "address", "block", "street"]);
  const descCol = metaOverrides.descCol ?? guessColumn(headers, ["description", "narrative", "details", "notes"]);
  const caseCol = metaOverrides.caseCol ?? guessColumn(headers, ["case", "report", "incident", "number"]);

  const rows: BlotterRow[] = [];
  for (let i = 1; i < Math.min(table.length, MAX_ROWS + 1); i++) {
    const row = table[i] ?? [];
    rows.push({
      date: parseIsoDate(dateCol >= 0 ? row[dateCol] ?? "" : ""),
      type: typeCol >= 0 ? row[typeCol] ?? "" : "",
      location: locCol >= 0 ? row[locCol] ?? "" : "",
      description: descCol >= 0 ? row[descCol] ?? "" : "",
      caseNumber: caseCol >= 0 ? row[caseCol] ?? "" : "",
    });
  }
  return rows;
}

// Convenience wrapper for callers that just want parsed rows from raw HTML
// (e.g. validating a candidate blotter URL) without the tables-vs-rows
// distinction ingestHtmlBlotter logs separately.
export function parseBlotterHtml(html: string, overrides: ColOverrides = {}): BlotterRow[] {
  const tables = parseHtmlTables(html);
  if (!tables.length) return [];
  const bestTable = tables.reduce((a, b) =>
    b.length * (b[0]?.length ?? 0) > a.length * (a[0]?.length ?? 0) ? b : a
  );
  return extractRowsFromTable(bestTable, overrides);
}

export async function ingestHtmlBlotter(
  locality: Locality,
  source: CivicSource,
  meta: MetaFor<"blotter_html">,
  ctx: AdapterContext
): Promise<AdapterResult> {
  const run = createRun(ctx, `[${locality.name}] blotter_html:`);
  const url = meta.url ?? source.url;
  if (!url) return run.fail("no url in source metadata");
  if (!(await robotsAllows(url, ctx))) return run.skip("disallowed by robots.txt — skipping");

  let html: string;
  try {
    const res = await safeFetch(ctx, url, {
      headers: { "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return run.fail(`HTTP ${res.status} from ${url}`);
    html = await readText(res, MAX_HTML_BYTES);
  } catch (err) {
    return run.fail(`fetch error — ${err}`);
  }

  const tables = parseHtmlTables(html);
  if (!tables.length) return run.fail(`no tables found at ${url}`);

  const overrides = {
    dateCol: meta.dateCol,
    typeCol: meta.typeCol,
    locCol: meta.locCol,
    descCol: meta.descCol,
    caseCol: meta.caseCol,
  };

  // Pick the widest table (most columns × rows = most content)
  const bestTable = tables.reduce((a, b) =>
    b.length * (b[0]?.length ?? 0) > a.length * (a[0]?.length ?? 0) ? b : a
  );

  const blotterRows = extractRowsFromTable(bestTable, overrides);
  if (!blotterRows.length) return run.fail("no rows parsed");
  if (bestTable.length - 1 > MAX_ROWS) {
    await run.problem(`table has ${bestTable.length - 1} rows; only the first ${MAX_ROWS} were read`);
  }

  const records: CivicRecord[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < blotterRows.length; i++) {
    const row = blotterRows[i]!;
    const title = [row.type, row.location].filter(Boolean).join(" — ") || "Police incident";
    // Case-numbered rows dedupe on locality + case number so the same case
    // survives the blotter page URL rotating. Rows without one are keyed by
    // their content: a positional key shifted whenever a new incident was added
    // at the top and re-inserted every row below it (see ../dedupe.ts).
    const dedupeKey = row.caseNumber
      ? `blotter_html:${locality.name}:${row.caseNumber}`
      : `blotter_html:${locality.name}:${contentKey([row.date, row.type, row.location, row.description], seen)}`;

    records.push({
      provider: "blotter_html",
      type: "police_blotter",
      title,
      summary: row.description || null,
      date: row.date,
      location: row.location || null,
      caseNumber: row.caseNumber || null,
      dedupeKey,
      localityName: locality.name,
      sourceId: source.id,
      raw: {
        incidentType: row.type,
        location: row.location,
        caseNumber: row.caseNumber,
      },
    });
  }

  const result = await ctx.sink.save(records);
  await ctx.logger?.log(
    `[${locality.name}] blotter_html: +${result.inserted} records, ${result.skipped} skipped from ${url}`
  );
  return run.done(result, records.length);
}
