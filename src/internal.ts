// Small shared helpers for resolving AdapterContext seams. Not exported from
// the package entry point.
import type { AdapterContext } from "./types.js";
import { isAllowedByRobots } from "./robots.js";

export const DEFAULT_USER_AGENT =
  "civic-data-adapters/0.1 (+https://github.com/mpointer/civic-data-adapters)";

export function ctxFetch(ctx: Pick<AdapterContext, "fetch">): typeof fetch {
  return ctx.fetch ?? fetch;
}

export function ctxUserAgent(ctx: Pick<AdapterContext, "userAgent">): string {
  return ctx.userAgent ?? DEFAULT_USER_AGENT;
}

/** robots.txt gate honoring ctx.skipRobotsCheck (check is ON by default). */
export async function robotsAllows(
  url: string,
  ctx: Pick<AdapterContext, "fetch" | "userAgent" | "skipRobotsCheck">
): Promise<boolean> {
  if (ctx.skipRobotsCheck) return true;
  return isAllowedByRobots(url, { fetch: ctx.fetch, userAgent: ctxUserAgent(ctx) });
}
