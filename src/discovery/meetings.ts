// Finds and VERIFIES a real Legistar clientId for a locality's borough, city,
// or county council.
//
// Propose→verify: ctx.generate only proposes candidate clientIds; every
// candidate is checked against the live Legistar Web API via
// verifyLegistarClient, so a returned DiscoveredSource means "this clientId
// answered the API", not "the model guessed a plausible subdomain". A
// plausible-looking clientId that 404s is worse than no result — this was
// learned the hard way when a hand-entered guess sat unverified for weeks.
//
// Scope note: this only covers the Legistar-hosted case. A generic agenda/
// minutes-page scraper for the (likely larger) set of towns with no Legistar
// site at all is a separate, harder parsing problem — not built here.
import type { Locality, DiscoveryContext, DiscoveredSource } from "../types.js";
import { verifyLegistarClient } from "../adapters/legistar.js";
import { parseCandidateJson, localityCityName } from "./candidates.js";

const MAX_CANDIDATES = 4;

/**
 * Propose Legistar clientIds via ctx.generate, verify each against the real
 * Legistar Web API, and return the first that answers (at most one source).
 * Returns [] when nothing was proposed or nothing verified.
 */
export async function discoverMeetingPortal(
  locality: Locality,
  ctx: DiscoveryContext
): Promise<DiscoveredSource[]> {
  const cityName = localityCityName(locality);

  const systemPrompt = `You find a US city/borough/county's Legistar clientId — the subdomain in "https://{clientId}.legistar.com", a public council-meeting/agenda platform used by roughly 3,500 US municipalities and counties.
Return ONLY a JSON array of up to ${MAX_CANDIDATES} candidate clientIds, most likely first: [{"clientId":"..."}]
Use web search to confirm each candidate — search for the town's own council/meetings page and look for an actual legistar.com link, or search "{city} legistar". Do not guess a clientId from the city name alone; a plausible-looking guess that 404s is worse than returning fewer candidates.
Many small towns have no Legistar site at all — if the town's own council doesn't use it, check whether the covering county does, since county-level meetings often include or affect the town. If truly nothing exists, return [].`;
  const prompt = `City: ${cityName}${locality.state ? `, ${locality.state}` : ""}.
Find its real Legistar clientId (or its county's, if the town itself has none), confirmed via web search — not guessed.`;

  const raw = await ctx.generate(systemPrompt, prompt);
  const candidates = parseCandidateJson(raw, "clientId").slice(0, MAX_CANDIDATES);
  if (!candidates.length) {
    await ctx.logger?.log(`[${locality.name}] meeting discovery: no candidates proposed`);
    return [];
  }

  for (const candidate of candidates) {
    const clientId = candidate.clientId.trim().toLowerCase();
    if (!clientId) continue;

    if (!(await verifyLegistarClient(clientId, ctx))) continue;

    await ctx.logger?.log(
      `[${locality.name}] meeting discovery: verified Legistar clientId '${clientId}'`
    );
    return [
      {
        provider: "legistar",
        name: `${cityName} Council (Legistar)`,
        url: `https://${clientId}.legistar.com`,
        meta: { provider: "legistar", clientId },
        evidence: `Legistar API answered for clientId '${clientId}'`,
      },
    ];
  }

  await ctx.logger?.log(
    `[${locality.name}] meeting discovery: none of ${candidates.length} candidate(s) verified`,
    "warn"
  );
  return [];
}
