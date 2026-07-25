// Finds and VERIFIES a public police-blotter page (HTML table, PDF, or a
// CrimeWatch feed) for a locality that has no open-data blotter dataset.
//
// Propose→verify: ctx.generate (ideally web-search-grounded) only proposes
// candidate URLs. Every candidate is then fetched and run through the same
// parsers the real adapters use — parseBlotterHtml, extractIncidents, or the
// CrimeWatch feed API — so a returned DiscoveredSource means "confirmed to
// yield rows right now", not "the model guessed this looks right". Neither
// blotter adapter needs per-city column config (both auto-detect columns), so
// a candidate URL only needs its actual format confirmed.
import { createRequire } from "node:module";
import type { Locality, DiscoveryContext, DiscoveredSource } from "../types.js";
import { ctxFetch, ctxUserAgent, robotsAllows } from "../internal.js";
import { parseBlotterHtml } from "../adapters/blotter-html.js";
import { extractIncidents } from "../adapters/blotter-pdf.js";
import { isCrimewatchUrl, fetchCrimewatchIncidents } from "../adapters/blotter-crimewatch.js";
import { parseCandidateJson, localityCityName } from "./candidates.js";

const require = createRequire(import.meta.url);

const MAX_CANDIDATES = 4;

async function tryHtml(url: string, ctx: DiscoveryContext): Promise<number> {
  if (!(await robotsAllows(url, ctx))) return 0;
  try {
    const res = await ctxFetch(ctx)(url, {
      headers: { "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return 0;
    return parseBlotterHtml(await res.text()).length;
  } catch {
    return 0;
  }
}

async function tryPdf(url: string, ctx: DiscoveryContext): Promise<number> {
  if (!(await robotsAllows(url, ctx))) return 0;
  try {
    const res = await ctxFetch(ctx)(url, {
      headers: { "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return 0;
    const buf = Buffer.from(await res.arrayBuffer());
    // Lazy require keeps pdf-parse out of bundler static analysis and off the
    // startup path (same pattern as the blotter_pdf adapter).
    const pdfParse = require("pdf-parse") as (
      b: Buffer,
      o?: { max?: number }
    ) => Promise<{ text: string }>;
    const parsed = await pdfParse(buf, { max: 20 });
    return extractIncidents(parsed.text).length;
  } catch {
    return 0;
  }
}

/**
 * Propose blotter URLs via ctx.generate, verify each with the real parsers,
 * and return the first candidate that actually yields rows (at most one
 * source — a locality needs one working blotter, not four). Returns [] when
 * nothing was proposed or nothing verified.
 */
export async function discoverBlotter(
  locality: Locality,
  ctx: DiscoveryContext
): Promise<DiscoveredSource[]> {
  const cityName = localityCityName(locality);

  const systemPrompt = `You find public police-department incident logs ("blotters") for US cities/towns — a page or PDF listing individual recent incidents (date, type, location), not a press-release feed or a generic PD homepage.
The exact city's own police department often has no public blotter — in that case, a neighboring township/borough/county police department whose coverage area includes or borders the city is a valid answer too, since local readers care about incidents in the surrounding area, not just the city line.
Return ONLY a JSON array of up to ${MAX_CANDIDATES} candidate URLs, most likely first: [{"url":"https://..."}]
Use web search to confirm each URL is real and currently active — do not guess from memory. If you truly can't find any nearby blotter, return [].`;
  const prompt = `City: ${cityName}${locality.state ? `, ${locality.state}` : ""}.
Find a public incident log / blotter page or PDF for this city's police department, or if none exists, the closest neighboring jurisdiction that covers or borders this area.`;

  const raw = await ctx.generate(systemPrompt, prompt);
  const candidates = parseCandidateJson(raw, "url").slice(0, MAX_CANDIDATES);
  if (!candidates.length) {
    await ctx.logger?.log(`[${locality.name}] blotter discovery: no candidates proposed`);
    return [];
  }

  for (const { url } of candidates) {
    // CrimeWatch (crimewatch.net / *.crimewatchpa.com) is client-side
    // rendered — no server <table> the generic HTML parser can see — so it
    // needs its own validator (calls the site's real feed API) rather than
    // ever reaching the generic HTML/PDF checks below.
    if (isCrimewatchUrl(url)) {
      const incidents = await fetchCrimewatchIncidents(url, ctx, 1);
      if (incidents.length > 0) {
        await ctx.logger?.log(
          `[${locality.name}] blotter discovery: verified ${url} via CrimeWatch feed (${incidents.length} incidents)`
        );
        return [
          {
            provider: "blotter_crimewatch",
            name: `${cityName} Police Blotter`,
            url,
            meta: { provider: "blotter_crimewatch", url, recordType: "police_blotter" },
            evidence: `CrimeWatch feed API returned ${incidents.length} incidents just now`,
          },
        ];
      }
      continue;
    }

    // Try the format the URL looks like first, then fall back to the other —
    // some PDs serve a PDF blotter from an extension-less URL, or vice versa.
    const looksLikePdf = /\.pdf(\?|$)/i.test(url);
    const order: Array<{
      provider: "blotter_html" | "blotter_pdf";
      check: (u: string, c: DiscoveryContext) => Promise<number>;
      what: string;
    }> = looksLikePdf
      ? [
          { provider: "blotter_pdf", check: tryPdf, what: "PDF incidents" },
          { provider: "blotter_html", check: tryHtml, what: "HTML blotter rows" },
        ]
      : [
          { provider: "blotter_html", check: tryHtml, what: "HTML blotter rows" },
          { provider: "blotter_pdf", check: tryPdf, what: "PDF incidents" },
        ];

    for (const { provider, check, what } of order) {
      const rows = await check(url, ctx);
      if (rows > 0) {
        await ctx.logger?.log(
          `[${locality.name}] blotter discovery: verified ${url} as ${provider} (${rows} rows)`
        );
        return [
          {
            provider,
            name: `${cityName} Police Blotter`,
            url,
            meta: { provider, url, recordType: "police_blotter" },
            evidence: `parsed ${rows} ${what} just now`,
          },
        ];
      }
    }
  }

  await ctx.logger?.log(
    `[${locality.name}] blotter discovery: none of ${candidates.length} candidate(s) verified`,
    "warn"
  );
  return [];
}
