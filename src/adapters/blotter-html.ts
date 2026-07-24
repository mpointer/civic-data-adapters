// HTML scraper for police blotter pages that don't have a Socrata/open-data feed.
// Fetches the blotter URL, walks the DOM for table rows, and hands results to
// the sink with type="police_blotter".
//
// Source metadata: { provider: "blotter_html", url: "https://pd.example.gov/blotter" }
// Optional column overrides: { dateCol?: 0, typeCol?: 1, locCol?: 2, descCol?: 3, caseCol?: 4 }
import type {
  Locality,
  CivicSource,
  CivicAdapterMeta,
  AdapterContext,
  AdapterResult,
  CivicRecord,
} from "../types.js";
import { ctxFetch, ctxUserAgent, robotsAllows } from "../internal.js";

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
  const m = clean.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  const isoMatch = clean.match(/^(\d{4}-\d{2}-\d{2})/);
  return isoMatch ? isoMatch[1]! : null;
}

// Lightweight HTML table parser — no external dependency needed.
// Returns rows as string[][] (text content of each cell).
export function parseHtmlTables(html: string): string[][][] {
  const tables: string[][][] = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const tagRe = /<[^>]+>/g;

  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;
    rowRe.lastIndex = 0;
    while ((rowMatch = rowRe.exec(tableMatch[1]!)) !== null) {
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      cellRe.lastIndex = 0;
      while ((cellMatch = cellRe.exec(rowMatch[1]!)) !== null) {
        cells.push(cellMatch[1]!.replace(tagRe, "").replace(/\s+/g, " ").trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length > 1) tables.push(rows);
  }
  return tables;
}

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
  meta: CivicAdapterMeta,
  ctx: AdapterContext
): Promise<AdapterResult> {
  const url = meta.url ?? source.url;
  if (!url) {
    await ctx.logger?.log(`[${locality.name}] blotter_html: no url in source metadata`, "warn");
    return { inserted: 0, skipped: 0 };
  }
  if (!(await robotsAllows(url, ctx))) {
    await ctx.logger?.log(
      `[${locality.name}] blotter_html: disallowed by robots.txt — skipping`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  let html: string;
  try {
    const res = await ctxFetch(ctx)(url, { headers: { "User-Agent": ctxUserAgent(ctx) } });
    if (!res.ok) {
      await ctx.logger?.log(`[${locality.name}] blotter_html: HTTP ${res.status} from ${url}`, "warn");
      return { inserted: 0, skipped: 0 };
    }
    html = await res.text();
  } catch (err) {
    await ctx.logger?.log(`[${locality.name}] blotter_html: fetch error — ${err}`, "warn");
    return { inserted: 0, skipped: 0 };
  }

  const tables = parseHtmlTables(html);
  if (!tables.length) {
    await ctx.logger?.log(`[${locality.name}] blotter_html: no tables found at ${url}`, "warn");
    return { inserted: 0, skipped: 0 };
  }

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
  if (!blotterRows.length) {
    await ctx.logger?.log(`[${locality.name}] blotter_html: no rows parsed`, "warn");
    return { inserted: 0, skipped: 0 };
  }

  const records: CivicRecord[] = [];

  for (let i = 0; i < blotterRows.length; i++) {
    const row = blotterRows[i]!;
    const title = [row.type, row.location].filter(Boolean).join(" — ") || "Police incident";
    // Case-numbered rows dedupe on locality + case number so the same case
    // survives the blotter page URL rotating; rows without one fall back to a
    // positional URL-scoped key (mirrors the original community-scoped
    // unique index).
    const dedupeKey = row.caseNumber
      ? `blotter_html:${locality.name}:${row.caseNumber}`
      : `blotter_html:${url}:${i}:${row.date ?? ""}`;

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
  return result;
}
