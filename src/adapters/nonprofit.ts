// ProPublica Nonprofit Explorer adapter.
// Fetches 990 filing data for nonprofits in the locality's city/state.
// No API key required. Free for non-commercial use.
//
// Source metadata shape:
//   { provider: "nonprofit_explorer", nteeFilter?: "A,B,C", lookbackDays?: number }
// nteeFilter: comma-separated NTEE major group letters to include (no filter = all groups).
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
import { ctxFetch, ctxUserAgent, robotsAllows } from "../internal.js";

const BASE_URL = "https://projects.propublica.org/nonprofits/api/v2/search.json";

// `q` is a nationwide fuzzy text search — there is no working server-side
// geographic filter (state.id is accepted but silently ignored: confirmed
// live 2026-07-15, `selected_state` stays null and num_pages/total_results
// come back identical with or without it; a bare `state` param still 500s,
// confirmed 2026-07-10). A common city name reports num_pages in the
// hundreds even though almost none of those pages contain a real match after
// the client-side city/state filter below. Walking all of them, with no
// per-fetch timeout, stranded several localities' scheduled runs past a
// 300-second serverless execution cap in production (2026-07-10 through
// 07-14) — killed mid-run, only recovered by a bookkeeping sweep, not a real
// completion. Cap pages walked and time-box each fetch so this can't hang
// the whole invocation.
const MAX_PAGES = 20;
const FETCH_TIMEOUT_MS = 15_000;
const TIME_BUDGET_MS = 60_000;

const NTEE_LABELS: Record<string, string> = {
  A: "Arts & Culture",
  B: "Education",
  C: "Environment",
  D: "Animal-Related",
  E: "Health Care",
  F: "Mental Health",
  G: "Disease & Disorders",
  H: "Medical Research",
  I: "Crime & Legal",
  J: "Employment",
  K: "Food & Agriculture",
  L: "Housing",
  M: "Public Safety",
  N: "Recreation & Sports",
  O: "Youth Development",
  P: "Human Services",
  Q: "International",
  R: "Civil Rights",
  S: "Community Development",
  T: "Philanthropy",
  U: "Science & Technology",
  V: "Social Science",
  W: "Public Affairs",
  X: "Religion",
  Y: "Mutual Benefit",
  Z: "Unknown",
};

interface PropublicaOrg {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  ntee_code: string | null;
  income_amount: number | null;
  asset_amount: number | null;
  filing_date: string | null;
  form_type: string | null;
}

interface PropublicaResponse {
  total_results: number;
  num_pages: number;
  cur_page: number;
  organizations: PropublicaOrg[];
}

function nteeCategory(code: string | null): string {
  if (!code) return "Nonprofit";
  const letter = code.charAt(0).toUpperCase();
  return NTEE_LABELS[letter] ?? "Nonprofit";
}

function isoSince(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

export async function ingestNonprofitExplorer(
  locality: Locality,
  source: CivicSource,
  meta: CivicAdapterMeta,
  ctx: AdapterContext
): Promise<AdapterResult> {
  if (!locality.state) {
    await ctx.logger?.log(
      `[${locality.name}] nonprofit_explorer: locality.state is not set — skipping`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  if (!(await robotsAllows(BASE_URL, ctx))) {
    await ctx.logger?.log(
      `[${locality.name}] nonprofit_explorer: disallowed by robots.txt — skipping`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  const nteeFilter = meta.nteeFilter
    ? new Set(meta.nteeFilter.toUpperCase().split(",").map((s) => s.trim()))
    : null;
  const lookbackDays = meta.lookbackDays ?? 730; // 2 years default
  const cutoffDate = isoSince(lookbackDays);

  const cityName = (locality.city ?? locality.name.split(",")[0] ?? locality.name).trim();
  const stateAbbr = locality.state.toUpperCase();
  const fetchImpl = ctxFetch(ctx);

  let page = 0;
  let totalPages = 1;
  let hitCap = false;
  const startedAt = Date.now();
  const records: CivicRecord[] = [];

  while (page < totalPages) {
    if (page >= MAX_PAGES) {
      hitCap = true;
      break;
    }
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      await ctx.logger?.log(
        `[${locality.name}] nonprofit_explorer: time budget reached at page ${page}/${totalPages} — stopping early`,
        "warn"
      );
      break;
    }
    // state.id doesn't actually filter (see file-header comment) — kept
    // since it's harmless and documents intent, unlike the bare `state` param
    // which 500s.
    const params = new URLSearchParams({
      q: cityName,
      "state.id": stateAbbr,
      page: String(page),
    });

    let data: PropublicaResponse;
    try {
      const res = await fetchImpl(`${BASE_URL}?${params}`, {
        headers: { "User-Agent": ctxUserAgent(ctx), Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await ctx.logger?.log(`[${locality.name}] nonprofit_explorer: HTTP ${res.status}`, "warn");
        break;
      }
      data = (await res.json()) as PropublicaResponse;
    } catch (err) {
      await ctx.logger?.log(`[${locality.name}] nonprofit_explorer: fetch error — ${err}`, "warn");
      break;
    }

    totalPages = data.num_pages;

    for (const org of data.organizations) {
      // Filter to orgs actually in this city (the search query is fuzzy).
      // Some orgs come back with a null city/state — confirmed live 2026-07-10.
      if ((org.city ?? "").toUpperCase() !== cityName.toUpperCase()) continue;
      if ((org.state ?? "").toUpperCase() !== stateAbbr) continue;

      // NTEE category filter
      const nteeGroup = org.ntee_code?.charAt(0).toUpperCase() ?? "";
      if (nteeFilter && nteeGroup && !nteeFilter.has(nteeGroup)) continue;

      // Skip orgs with no recent filings if cutoff set
      if (org.filing_date && org.filing_date < cutoffDate) continue;

      const category = nteeCategory(org.ntee_code);
      const income =
        org.income_amount != null
          ? `$${Math.round(org.income_amount).toLocaleString()} income`
          : null;
      const assets =
        org.asset_amount != null
          ? `$${Math.round(org.asset_amount).toLocaleString()} assets`
          : null;

      records.push({
        provider: "nonprofit_explorer",
        type: "nonprofit_filing",
        title: org.name,
        summary: [category, income, assets].filter(Boolean).join(" · ") || null,
        url: `https://projects.propublica.org/nonprofits/organizations/${org.ein}`,
        date: org.filing_date?.slice(0, 10) ?? null,
        dedupeKey: `propublica:nonprofit:${org.ein}`,
        localityName: locality.name,
        sourceId: source.id,
        raw: {
          ein: org.ein,
          nteeCode: org.ntee_code,
          category,
          incomeAmount: org.income_amount,
          assetAmount: org.asset_amount,
          formType: org.form_type,
        },
      });
    }

    page++;
    if (page < totalPages && page < MAX_PAGES) await new Promise((r) => setTimeout(r, 300));
  }

  if (hitCap) {
    await ctx.logger?.log(
      `[${locality.name}] nonprofit_explorer: hit page cap (${MAX_PAGES}/${totalPages}) — results may be incomplete`,
      "warn"
    );
  }
  const result = await ctx.sink.save(records);
  await ctx.logger?.log(
    `[${locality.name}] nonprofit_explorer: +${result.inserted} records, ${result.skipped} skipped`
  );
  return result;
}
