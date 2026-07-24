// USASpending.gov federal awards adapter.
// Fetches federal contracts and/or grants awarded to recipients in the
// locality's city. No API key required. Rate limited to ~2 req/sec — we
// sleep 500ms between pages.
//
// Source metadata shape:
//   { provider: "usaspending", awardTypes?: "contracts"|"grants"|"all", lookbackDays?: number }
// Requires: locality.state (2-letter abbr) and a city name
// (locality.city, else the part of locality.name before any comma).
import type {
  Locality,
  CivicSource,
  CivicAdapterMeta,
  AdapterContext,
  AdapterResult,
  CivicRecord,
} from "../types.js";
import { ctxFetch, ctxUserAgent } from "../internal.js";
import { sanitizeCivicDate } from "../registry.js";

const BASE_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const PAGE_SIZE = 100;

// Defensive cap + per-fetch timeout, the same guard the nonprofit adapter
// needed after unbounded pagination with no per-fetch timeout hung a
// production run past a 300-second serverless execution cap.
// place_of_performance filtering here is a real structured API filter
// (unlike Nonprofit Explorer's fuzzy text search), so this one hasn't
// actually timed out in production, but it shared the exact same unbounded
// while(true) shape, so it gets the same guard.
const MAX_PAGES = 50;
const FETCH_TIMEOUT_MS = 15_000;
const TIME_BUDGET_MS = 60_000;

const CONTRACT_CODES = ["A", "B", "C", "D"];
const GRANT_CODES = ["02", "03", "04", "05"];

// Field names as actually returned by /api/v2/search/spending_by_award/ —
// confirmed live 2026-07-11. The names used before this fix ("Period of
// Performance Start Date", "Awarding Agency Name", "Award Type",
// "generated_unique_award_id") silently come back null for every award
// (contracts AND grants) despite being valid-looking, accepted field names —
// the endpoint doesn't error on an unsupported field, it just nulls it. That
// was the root cause of every contract/grant record having no date.
interface USASpendingResult {
  "Award ID": string;
  "Recipient Name": string;
  "Award Amount": number | null;
  Description: string | null;
  "Awarding Agency": string | null;
  "Start Date": string | null;
}

interface USASpendingResponse {
  results: USASpendingResult[];
  page_metadata: { page: number; total: number; has_next_page: boolean };
}

function isoSince(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// Fetches one award-code group's paginated results. The API rejects a request
// whose award_type_codes mix groups ("must only contain types from one
// group") — confirmed live 2026-07-10 — so "all" mode has to run this twice
// (contracts, then grants) rather than in one combined call. The
// `sort`/`order` params were also dropped: USASpending's valid sort-value set
// differs per award type and doesn't reliably match our `fields` list
// (confirmed live — same request 400s with sort, 200s without), and we don't
// need server-side ordering since every award still gets deduped on Award ID
// regardless of what order it arrives in.
//
// recordType is passed in rather than inferred from a per-row "Award Type"
// field: that field never actually populates (see USASpendingResult comment
// above), and we already know unambiguously which group this call is for.
async function fetchAwardGroup(
  locality: Locality,
  source: CivicSource,
  awardCodes: string[],
  recordType: "contract" | "grant",
  startDate: string,
  endDate: string,
  cityName: string,
  stateAbbr: string,
  ctx: AdapterContext
): Promise<CivicRecord[]> {
  let page = 1;
  let hitCap = false;
  const startedAt = Date.now();
  const records: CivicRecord[] = [];
  const fetchImpl = ctxFetch(ctx);

  while (true) {
    if (page > MAX_PAGES) {
      hitCap = true;
      break;
    }
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      await ctx.logger?.log(
        `[${locality.name}] usaspending (${recordType}): time budget reached at page ${page} — stopping early`,
        "warn"
      );
      break;
    }
    const body = {
      filters: {
        award_type_codes: awardCodes,
        place_of_performance_locations: [
          { country: "USA", state: stateAbbr, city: cityName },
        ],
        time_period: [{ start_date: startDate, end_date: endDate }],
      },
      fields: [
        "Award ID",
        "Recipient Name",
        "Award Amount",
        "Description",
        "Awarding Agency",
        "Start Date",
      ],
      page,
      limit: PAGE_SIZE,
    };

    let data: USASpendingResponse;
    try {
      const res = await fetchImpl(BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": ctxUserAgent(ctx) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await ctx.logger?.log(`[${locality.name}] usaspending: HTTP ${res.status}`, "warn");
        break;
      }
      data = (await res.json()) as USASpendingResponse;
    } catch (err) {
      await ctx.logger?.log(`[${locality.name}] usaspending: fetch error — ${err}`, "warn");
      break;
    }

    for (const award of data.results) {
      const uniqueId = award["Award ID"];
      const amount = award["Award Amount"];
      const amountStr = amount != null ? `$${Math.round(amount).toLocaleString()}` : "";
      const agency = award["Awarding Agency"] ?? "";
      const isoDate = sanitizeCivicDate(award["Start Date"]);

      const title = [award["Recipient Name"] ?? "Unknown recipient", amountStr]
        .filter(Boolean)
        .join(" — ");

      const summary =
        [award.Description, agency ? `via ${agency}` : ""].filter(Boolean).join("; ") || null;

      const awardUrl = uniqueId
        ? `https://www.usaspending.gov/award/${encodeURIComponent(uniqueId)}/`
        : null;

      // Note on dedupe semantics: the original pipeline UPSERTED these rows
      // (update-on-conflict) so rows ingested before the field-name fix above
      // could self-correct on later runs. Sinks that want that behavior
      // should treat a dedupeKey match as an update rather than a skip.
      records.push({
        provider: "usaspending",
        type: recordType,
        title,
        summary,
        url: awardUrl,
        date: isoDate,
        amountCents: amount != null ? Math.round(amount * 100) : null,
        dedupeKey: `usaspending:${uniqueId}`,
        localityName: locality.name,
        sourceId: source.id,
        raw: {
          awardId: award["Award ID"],
          amount,
          agency,
          description: award.Description,
        },
      });
    }

    if (!data.page_metadata.has_next_page) break;
    page++;
    if (page <= MAX_PAGES) await new Promise((r) => setTimeout(r, 500));
  }

  if (hitCap) {
    await ctx.logger?.log(
      `[${locality.name}] usaspending (${recordType}): hit page cap (${MAX_PAGES}) — results may be incomplete`,
      "warn"
    );
  }
  return records;
}

export async function ingestUSASpending(
  locality: Locality,
  source: CivicSource,
  meta: CivicAdapterMeta,
  ctx: AdapterContext
): Promise<AdapterResult> {
  if (!locality.state) {
    await ctx.logger?.log(
      `[${locality.name}] usaspending: locality.state is not set — skipping`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  const awardTypes = meta.awardTypes ?? "all";
  const lookbackDays = meta.lookbackDays ?? 365;
  const startDate = isoSince(lookbackDays);
  const endDate = isoToday();
  // Strip a trailing ", ST" from the locality name if no explicit city is set
  const cityName = (locality.city ?? locality.name.split(",")[0] ?? locality.name).trim();
  const stateAbbr = locality.state.toUpperCase();

  const groups: Array<{ codes: string[]; recordType: "contract" | "grant" }> =
    awardTypes === "contracts" ? [{ codes: CONTRACT_CODES, recordType: "contract" }]
    : awardTypes === "grants" ? [{ codes: GRANT_CODES, recordType: "grant" }]
    : [
        { codes: CONTRACT_CODES, recordType: "contract" },
        { codes: GRANT_CODES, recordType: "grant" },
      ];

  const records: CivicRecord[] = [];
  for (const { codes, recordType } of groups) {
    records.push(
      ...(await fetchAwardGroup(
        locality,
        source,
        codes,
        recordType,
        startDate,
        endDate,
        cityName,
        stateAbbr,
        ctx
      ))
    );
  }

  const result = await ctx.sink.save(records);
  await ctx.logger?.log(
    `[${locality.name}] usaspending: +${result.inserted} records, ${result.skipped} skipped`
  );
  return result;
}
