// Provider registry: maps a CivicAdapterMeta.provider string to its adapter
// and runs it. granicus/civicplus/boarddocs are recognized but stubbed — they
// have no public API and need manual per-site setup.
import type {
  Locality,
  CivicSource,
  CivicAdapterMeta,
  AdapterContext,
  AdapterResult,
} from "./types.js";
import { ingestLegistar } from "./adapters/legistar.js";
import { ingestHtmlMinutes } from "./adapters/html-minutes.js";
import { ingestSocrataRecords } from "./adapters/blotter-socrata.js";
import { ingestHtmlBlotter } from "./adapters/blotter-html.js";
import { ingestPdfBlotter } from "./adapters/blotter-pdf.js";
import { ingestCrimewatchBlotter } from "./adapters/blotter-crimewatch.js";
import { ingestUSASpending } from "./adapters/usaspending.js";
import { ingestNonprofitExplorer } from "./adapters/nonprofit.js";

// Civic source data is often messy (a state open-data field can hold a typo'd
// or genuinely wrong date — one state kennel-inspection row arrived dated
// nearly two years in the future, caught in a production review). The record
// date typically drives every "recent activity" view downstream, so an
// unvalidated future date doesn't just look odd — it can make a page
// permanently claim there's upcoming/current activity that hasn't happened.
// Reject anything more than a year out rather than trusting the raw source
// value.
const MAX_FUTURE_DAYS = 366;

export function sanitizeCivicDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iso = raw.slice(0, 10);
  const parsed = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() > Date.now() + MAX_FUTURE_DAYS * 86_400_000) return null;
  return iso;
}

type CivicAdapter = (
  locality: Locality,
  source: CivicSource,
  meta: CivicAdapterMeta,
  ctx: AdapterContext
) => Promise<AdapterResult>;

function stubAdapter(provider: string): CivicAdapter {
  return async (_locality, _source, _meta, ctx) => {
    await ctx.logger?.log(
      `${provider}: no public API available — manual setup required; skipping`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  };
}

const CIVIC_ADAPTERS: Record<string, CivicAdapter> = {
  legistar: async (locality, source, meta, ctx) => {
    const result = await ingestLegistar(locality, source, meta, ctx);
    await ctx.logger?.log(
      `[${locality.name}] legistar: +${result.inserted} records, ${result.skipped} already present`
    );
    return result;
  },
  html_minutes: ingestHtmlMinutes,
  socrata: ingestSocrataRecords,
  blotter_html: ingestHtmlBlotter,
  blotter_pdf: ingestPdfBlotter,
  blotter_crimewatch: ingestCrimewatchBlotter,
  usaspending: ingestUSASpending,
  nonprofit_explorer: ingestNonprofitExplorer,
  granicus: stubAdapter("granicus"),
  civicplus: stubAdapter("civicplus"),
  boarddocs: stubAdapter("boarddocs"),
};

export async function runAdapter(
  locality: Locality,
  source: CivicSource,
  meta: CivicAdapterMeta,
  ctx: AdapterContext
): Promise<AdapterResult> {
  const provider = meta.provider ?? "legistar";
  const adapter = CIVIC_ADAPTERS[provider];

  if (!adapter) {
    await ctx.logger?.log(
      `[${locality.name}] source ${source.id}: unknown provider '${provider}' — skipping`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  return adapter(locality, source, meta, ctx);
}
