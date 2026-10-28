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
import { assertPublicHttpUrl, ctxFetch, ctxUserAgent, robotsAllows } from "../internal.js";
import { parseBlotterHtml } from "../adapters/blotter-html.js";
import { extractIncidents } from "../adapters/blotter-pdf.js";
import { isCrimewatchUrl, fetchCrimewatchIncidents } from "../adapters/blotter-crimewatch.js";
import { parseCandidateJson, localityCityName } from "./candidates.js";

const require = createRequire(import.meta.url);

const MAX_CANDIDATES = 4;
const DEFAULT_YES = 0.7;
const DEFAULT_NO = 0.3;
const SAMPLE_CHARS = 1_500;

/** What a format check found: how many rows parsed, plus text to verify. */
interface CheckResult {
  rows: number;
  sample: string;
}
const NONE: CheckResult = { rows: 0, sample: "" };

type Verdict = "accept" | "reject" | "review";

/**
 * Optional ctx.verify gate: do the parsed rows actually look like a police
 * blotter? Parsers alone accept any table with 2+ rows. Fails open on verifier
 * errors so discovery never gets WORSE by opting in.
 */
async function looksLikeBlotter(
  sample: string,
  ctx: DiscoveryContext
): Promise<{ verdict: Verdict; note: string }> {
  if (!ctx.verify) return { verdict: "accept", note: "" };
  let yes = ctx.verifyThresholds?.yes ?? DEFAULT_YES;
  let no = ctx.verifyThresholds?.no ?? DEFAULT_NO;
  if (!(no < yes) || no < 0 || yes > 1) {
    await ctx.logger?.log(
      `blotter discovery: invalid verifyThresholds (need 0 <= no < yes <= 1), using ${DEFAULT_YES}/${DEFAULT_NO}`,
      "warn"
    );
    yes = DEFAULT_YES;
    no = DEFAULT_NO;
  }
  try {
    const p = await ctx.verify(
      "Does the text below list individual police incidents, each with a date, an offense and a location?",
      sample
    );
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`score ${String(p)} is not a probability in [0, 1]`);
    }
    const note = ` (verify: ${p.toFixed(2)})`;
    if (p >= yes) return { verdict: "accept", note };
    if (p <= no) return { verdict: "reject", note };
    return { verdict: "review", note: ` (verify: ${p.toFixed(2)}, needs review)` };
  } catch (err) {
    await ctx.logger?.log(`blotter discovery: verify failed, trusting parsers — ${err}`, "warn");
    return { verdict: "accept", note: "" };
  }
}

async function tryHtml(url: string, ctx: DiscoveryContext): Promise<CheckResult> {
  if (!(await robotsAllows(url, ctx))) return NONE;
  try {
    const res = await ctxFetch(ctx)(url, {
      headers: { "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return NONE;
    const rows = parseBlotterHtml(await res.text());
    const sample = rows
      .slice(0, 8)
      .map((r) => [r.date, r.type, r.location, r.description].filter(Boolean).join(" | "))
      .join("\n")
      .slice(0, SAMPLE_CHARS);
    return { rows: rows.length, sample };
  } catch {
    return NONE;
  }
}

async function tryPdf(url: string, ctx: DiscoveryContext): Promise<CheckResult> {
  if (!(await robotsAllows(url, ctx))) return NONE;
  try {
    const res = await ctxFetch(ctx)(url, {
      headers: { "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return NONE;
    const buf = Buffer.from(await res.arrayBuffer());
    // Lazy require keeps pdf-parse out of bundler static analysis and off the
    // startup path (same pattern as the blotter_pdf adapter).
    const pdfParse = require("pdf-parse") as (
      b: Buffer,
      o?: { max?: number }
    ) => Promise<{ text: string }>;
    const parsed = await pdfParse(buf, { max: 20 });
    const incidents = extractIncidents(parsed.text);
    const sample = incidents
      .slice(0, 8)
      .map((i) => i.text)
      .join("\n")
      .slice(0, SAMPLE_CHARS);
    return { rows: incidents.length, sample };
  } catch {
    return NONE;
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

  // First candidate verify was unsure about; returned only if none is confident.
  let fallback: DiscoveredSource | null = null;

  for (const { url } of candidates) {
    // The LLM chose this URL from the open web, so treat it as untrusted: never
    // let it steer a request at localhost, a private range, or cloud metadata.
    try {
      assertPublicHttpUrl(url);
    } catch {
      await ctx.logger?.log(
        `[${locality.name}] blotter discovery: skipping non-public candidate ${url}`,
        "warn"
      );
      continue;
    }

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
      check: (u: string, c: DiscoveryContext) => Promise<CheckResult>;
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
      const { rows, sample } = await check(url, ctx);
      if (rows > 0) {
        const gate = await looksLikeBlotter(sample, ctx);
        if (gate.verdict === "reject") {
          await ctx.logger?.log(
            `[${locality.name}] blotter discovery: ${url} parsed as ${provider} but verify rejected it${gate.note}`,
            "warn"
          );
          continue;
        }
        const source: DiscoveredSource = {
          provider,
          name: `${cityName} Police Blotter`,
          url,
          meta: { provider, url, recordType: "police_blotter" },
          evidence: `parsed ${rows} ${what} just now${gate.note}`,
          ...(gate.verdict === "review" ? { needsReview: true } : {}),
        };
        if (gate.verdict === "review") {
          fallback ??= source;
          continue;
        }
        await ctx.logger?.log(
          `[${locality.name}] blotter discovery: verified ${url} as ${provider} (${rows} rows)`
        );
        return [source];
      }
    }
  }

  if (fallback) {
    await ctx.logger?.log(
      `[${locality.name}] blotter discovery: no confident candidate; returning ${fallback.url} flagged for review`,
      "warn"
    );
    return [fallback];
  }

  await ctx.logger?.log(
    `[${locality.name}] blotter discovery: none of ${candidates.length} candidate(s) verified`,
    "warn"
  );
  return [];
}
