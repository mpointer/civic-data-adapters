// Socrata open-data adapter — supports police blotter and generic civic record types.
// Blotter usage (backwards-compatible):
//   { provider: "socrata", url: "https://data.example.gov", resourceId: "xxxx-xxxx",
//     dateField?: "incident_date", typeField?: "offense_type", locationField?: "block_address",
//     caseField?: "report_number", descriptionField?: "description", since?: "2024-01-01" }
//
// Generic usage (permits, contracts, inspections, violations, etc.):
//   { provider: "socrata", url: "...", resourceId: "...", recordType: "permit",
//     dateField: "issued_date", caseField: "permit_number",
//     titleFields: ["permit_type", "applicant_name"], summaryFields: ["description"] }
import type {
  Locality,
  CivicSource,
  MetaFor,
  AdapterContext,
  AdapterResult,
  CivicRecord,
  CivicRecordType,
} from "../types.js";
import { ctxFetch, ctxUserAgent } from "../internal.js";
import { sanitizeCivicDate } from "../dates.js";

const WINDOW_DAYS = 90;
const PAGE_LIMIT = 1000;

interface SocrataRow {
  [key: string]: string | number | null | undefined;
}

function isoSince(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

function pickField(row: SocrataRow, candidates: string[]): string {
  for (const c of candidates) {
    const v = row[c];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

// Note on dedupe semantics: the original pipeline UPSERTED these rows
// (update-on-conflict, not skip) so that rows first ingested with a bad or
// missing date before the sanitizeCivicDate fix shipped would self-correct
// on later runs. Sinks that want that behavior should treat a dedupeKey
// match as an update rather than a skip.
export async function ingestSocrataRecords(
  locality: Locality,
  source: CivicSource,
  meta: MetaFor<"socrata">,
  ctx: AdapterContext
): Promise<AdapterResult> {
  if (!meta.url || !meta.resourceId) {
    await ctx.logger?.log(
      `[${locality.name}] socrata: missing url or resourceId in source metadata`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  const recordType: CivicRecordType = meta.recordType ?? "police_blotter";
  const since = meta.since ?? isoSince(WINDOW_DAYS);
  const dateField = meta.dateField ?? "date";

  const endpoint = `${meta.url.replace(/\/$/, "")}/resource/${meta.resourceId}.json`;
  const isBlotter = recordType === "police_blotter" && !meta.titleFields;
  const fetchImpl = ctxFetch(ctx);

  let offset = 0;
  const records: CivicRecord[] = [];
  // Page cap (parallel to nonprofit_explorer's): huge datasets like a big
  // city's 311 feed can hold a million rows per month, and unbounded
  // pagination both hammers the public API and floods the sink. Found live:
  // the first smoke test against NYC 311 ingested 975k records. Override
  // with meta.maxPages for deliberate bulk pulls.
  const maxPages = meta.maxPages ?? 20;
  let pages = 0;

  while (true) {
    if (pages >= maxPages) {
      await ctx.logger?.log(
        `[${locality.name}] socrata: hit page cap (${maxPages} × ${PAGE_LIMIT}) — results may be incomplete; raise meta.maxPages for bulk pulls`,
        "warn",
      );
      break;
    }
    pages++;
    const params = new URLSearchParams({
      $limit: String(PAGE_LIMIT),
      $offset: String(offset),
      $order: `${dateField} DESC`,
      $where: `${dateField} >= '${since}'`,
    });

    let rows: SocrataRow[];
    try {
      const res = await fetchImpl(`${endpoint}?${params}`, {
        headers: { "User-Agent": ctxUserAgent(ctx), Accept: "application/json" },
      });
      if (!res.ok) {
        await ctx.logger?.log(
          `[${locality.name}] socrata: HTTP ${res.status} from ${endpoint}`,
          "warn"
        );
        break;
      }
      rows = (await res.json()) as SocrataRow[];
    } catch (err) {
      await ctx.logger?.log(`[${locality.name}] socrata: fetch error — ${err}`, "warn");
      break;
    }

    if (!rows.length) break;

    for (const row of rows) {
      const rawDate = pickField(row, [
        dateField,
        "date",
        "occurred_date",
        "dispatch_date",
        "issued_date",
        "filed_date",
      ]);
      const isoDate = sanitizeCivicDate(rawDate);

      let title: string;
      let summary: string | null;
      let location: string | null = null;
      let caseNumber: string;
      let details: Record<string, string>;
      let externalId: string;

      if (isBlotter) {
        const typeField = meta.typeField ?? "offense_type";
        const locationField = meta.locationField ?? "block_address";
        const caseField = meta.caseField ?? "report_number";
        const descField = meta.descriptionField ?? "description";

        const incidentType = pickField(row, [typeField, "offense", "offense_type", "crime_type", "call_type"]);
        location = pickField(row, [locationField, "block_address", "location_description", "address"]) || null;
        caseNumber = pickField(row, [caseField, "report_number", "case_number", "incident_number"]);
        const description = pickField(row, [descField, "description", "narrative", "notes"]);

        title = [incidentType, location].filter(Boolean).join(" — ") || "Police incident";
        summary = description || null;
        details = { incidentType, location: location ?? "", caseNumber, rawDate };
        externalId = caseNumber || `${meta.resourceId}:${offset + rows.indexOf(row)}`;
      } else {
        const titleParts = meta.titleFields
          ? meta.titleFields.map((f) => pickField(row, [f])).filter(Boolean)
          : [pickField(row, ["title", "name", "description", "type"])];
        const summaryParts = meta.summaryFields
          ? meta.summaryFields.map((f) => pickField(row, [f])).filter(Boolean)
          : [pickField(row, ["description", "notes", "comments", "narrative"])];

        caseNumber = meta.caseField
          ? pickField(row, [meta.caseField])
          : pickField(row, ["id", "objectid", "record_id", "permit_number", "case_number", "contract_id"]);

        title = titleParts.join(" — ") || `${recordType.replace("_", " ")} record`;
        summary = summaryParts.join("; ") || null;
        details = {
          rawDate,
          ...(caseNumber && { caseNumber }),
          ...(meta.amountField && { amount: pickField(row, [meta.amountField]) }),
        };
        externalId = caseNumber || `${meta.resourceId}:${offset + rows.indexOf(row)}`;
      }

      records.push({
        provider: "socrata",
        type: recordType,
        title,
        summary,
        date: isoDate,
        location,
        caseNumber: caseNumber || null,
        dedupeKey: `socrata:${meta.resourceId}:${externalId}`,
        localityName: locality.name,
        sourceId: source.id,
        raw: details,
      });
    }

    if (rows.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }

  const result = await ctx.sink.save(records);
  await ctx.logger?.log(
    `[${locality.name}] socrata ${recordType}: +${result.inserted} records, ${result.skipped} skipped`
  );
  return result;
}

// Backwards-compatible alias
export const ingestSocrataBlotter = ingestSocrataRecords;
