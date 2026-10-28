// Small shared helpers for resolving AdapterContext seams. Not exported from
// the package entry point.
import { isIP } from "node:net";
import type { AdapterContext } from "./types.js";
import { isAllowedByRobots } from "./robots.js";

export const DEFAULT_USER_AGENT =
  "civic-data-adapters/0.5.0 (+https://github.com/mpointer/civic-data-adapters)";

/** Deadline for a single outbound request. Node's own default is ~300 s. */
export const FETCH_TIMEOUT_MS = 30_000;

export function ctxFetch(ctx: Pick<AdapterContext, "fetch">): typeof fetch {
  return ctx.fetch ?? fetch;
}

export function ctxUserAgent(ctx: Pick<AdapterContext, "userAgent">): string {
  return ctx.userAgent ?? DEFAULT_USER_AGENT;
}

/** robots.txt gate. Resolution order: a bring-your-own `robotsCheck` hook
 *  runs INSTEAD of the bundled checker; otherwise `skipRobotsCheck`
 *  disables checking; otherwise the bundled checker runs (the default). */
export async function robotsAllows(
  url: string,
  ctx: Pick<AdapterContext, "fetch" | "userAgent" | "skipRobotsCheck" | "robotsCheck">
): Promise<boolean> {
  if (ctx.robotsCheck) return ctx.robotsCheck(url);
  if (ctx.skipRobotsCheck) return true;
  return isAllowedByRobots(url, { fetch: ctx.fetch, userAgent: ctxUserAgent(ctx) });
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local, incl. the cloud metadata service
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    );
  }
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
  }
  return false;
}

/**
 * Throw unless `raw` is an http(s) URL whose host is not obviously internal.
 * Use it on URLs that came from an untrusted source (an LLM, a scraped page).
 *
 * This inspects the URL only: IP literals, `localhost`, and `.local`/`.internal`
 * names. It does NOT resolve DNS, so a public-looking hostname that resolves to a
 * private address (DNS rebinding) passes. Defend that layer with an egress
 * allowlist or a resolver-level check in your fetch implementation.
 */
export function assertPublicHttpUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`blocked scheme ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    isPrivateIp(host)
  ) {
    throw new Error(`blocked host ${host}`);
  }
  return u;
}
