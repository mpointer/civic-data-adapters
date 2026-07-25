// One-call discovery: run blotter + meeting-portal discovery (and, when a
// Socrata portal URL is provided, the catalog search) and concatenate the
// verified results. Cross-run idempotency — "do I already have this source?"
// — is the caller's job; every entry returned here was verified against the
// live source during this call.
import type { Locality, DiscoveryContext, DiscoveredSource } from "../types.js";
import { discoverBlotter } from "./blotter.js";
import { discoverMeetingPortal } from "./meetings.js";
import { searchSocrataCatalog } from "./socrata-catalog.js";

export { discoverBlotter } from "./blotter.js";
export { discoverMeetingPortal } from "./meetings.js";
export { searchSocrataCatalog } from "./socrata-catalog.js";
export { parseCandidateJson } from "./candidates.js";

export async function discover(
  locality: Locality,
  ctx: DiscoveryContext & { socrataPortalUrl?: string }
): Promise<DiscoveredSource[]> {
  const results: DiscoveredSource[] = [];

  const blotter = await discoverBlotter(locality, ctx);
  await ctx.logger?.log(`[${locality.name}] discovery: blotter → ${blotter.length} source(s)`);
  results.push(...blotter);

  const meetings = await discoverMeetingPortal(locality, ctx);
  await ctx.logger?.log(`[${locality.name}] discovery: meetings → ${meetings.length} source(s)`);
  results.push(...meetings);

  if (ctx.socrataPortalUrl) {
    const catalog = await searchSocrataCatalog(locality, ctx.socrataPortalUrl, ctx);
    await ctx.logger?.log(
      `[${locality.name}] discovery: socrata catalog → ${catalog.length} source(s)`
    );
    results.push(...catalog);
  }

  return results;
}
