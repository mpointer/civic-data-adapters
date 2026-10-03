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

export { sanitizeCivicDate } from "./dates.js";

async function stub(provider: string, locality: Locality, ctx: AdapterContext): Promise<AdapterResult> {
  await ctx.logger?.log(
    `[${locality.name}] ${provider}: no public API available — manual setup required; skipping`,
    "warn"
  );
  return { inserted: 0, skipped: 0 };
}

export async function runAdapter(
  locality: Locality,
  source: CivicSource,
  meta: CivicAdapterMeta,
  ctx: AdapterContext
): Promise<AdapterResult> {
  // Metadata often arrives as untyped JSON, so tolerate what the types forbid:
  // a missing provider has always meant legistar.
  const resolved = (
    (meta as { provider?: string }).provider === undefined ? { ...meta, provider: "legistar" } : meta
  ) as CivicAdapterMeta;

  switch (resolved.provider) {
    case "legistar": {
      const result = await ingestLegistar(locality, source, resolved, ctx);
      await ctx.logger?.log(
        `[${locality.name}] legistar: +${result.inserted} records, ${result.skipped} already present`
      );
      return result;
    }
    case "html_minutes":
      return ingestHtmlMinutes(locality, source, resolved, ctx);
    case "socrata":
      return ingestSocrataRecords(locality, source, resolved, ctx);
    case "blotter_html":
      return ingestHtmlBlotter(locality, source, resolved, ctx);
    case "blotter_pdf":
      return ingestPdfBlotter(locality, source, resolved, ctx);
    case "blotter_crimewatch":
      return ingestCrimewatchBlotter(locality, source, resolved, ctx);
    case "usaspending":
      return ingestUSASpending(locality, source, resolved, ctx);
    case "nonprofit_explorer":
      return ingestNonprofitExplorer(locality, source, resolved, ctx);
    case "granicus":
    case "civicplus":
    case "boarddocs":
      return stub(resolved.provider, locality, ctx);
    default: {
      // Unreachable by type; reachable at runtime with bad stored JSON.
      const unknown = (resolved as { provider: unknown }).provider;
      await ctx.logger?.log(
        `[${locality.name}] source ${source.id}: unknown provider '${String(unknown)}' — skipping`,
        "warn"
      );
      return { inserted: 0, skipped: 0 };
    }
  }
}
