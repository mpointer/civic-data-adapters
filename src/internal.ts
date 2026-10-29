// Small shared helpers for resolving AdapterContext seams. Not exported from
// the package entry point.
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { AdapterContext } from "./types.js";
import { isAllowedByRobots } from "./robots.js";

export const DEFAULT_USER_AGENT =
  "civic-data-adapters/0.6.0 (+https://github.com/mpointer/civic-data-adapters)";

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

export function isPrivateIp(ip: string): boolean {
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
 * names. It does NOT resolve DNS; `assertPublicHost` does that.
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


type Lookup = (host: string) => Promise<string[]>;
const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/**
 * Throw if `host` resolves to a private, loopback or link-local address, so a
 * public-looking name pointed at an internal service is refused. A name this
 * machine cannot resolve is NOT refused: the fetch will report that itself, and
 * a proxied environment may resolve names somewhere else.
 *
 * This is a pre-flight check, not a guarantee. The connection resolves the name
 * again, so a resolver that answers differently the second time (true DNS
 * rebinding) can still get through. For that, give `ctx.fetch` an implementation
 * that validates the address at connect time (for example an undici Agent whose
 * `connect.lookup` calls `isPrivateIp`).
 */
export async function assertPublicHost(host: string, lookup: Lookup = defaultLookup): Promise<void> {
  const clean = host.replace(/^\[|\]$/g, "");
  if (isIP(clean)) return; // literals are vetted by assertPublicHttpUrl
  let addresses: string[];
  try {
    addresses = await lookup(clean);
  } catch {
    return;
  }
  const bad = addresses.find(isPrivateIp);
  if (bad) throw new Error(`host ${host} resolves to private address ${bad}`);
}

const MAX_REDIRECTS = 5;

export interface SafeFetchOptions {
  /** Resolve names with this instead of the system resolver (tests). Also turns the DNS check on for a custom `ctx.fetch`. */
  lookup?: Lookup;
  /** Vet the first URL as well as every redirect target. Use for URLs an LLM or a scraped page supplied. */
  guardInitial?: boolean;
}

/**
 * `fetch` that follows redirects itself, so each hop is checked before it is
 * requested: http(s) only, not an internal host, not resolving to a private
 * address, and allowed by robots.txt. The platform `fetch` follows up to 20
 * redirects blindly, which lets a public page send the request to
 * `http://169.254.169.254/` or to a path robots.txt forbids. At most 5 hops.
 *
 * The DNS check runs only for the default network `fetch` (a custom `ctx.fetch`
 * may be a proxy or a test double) unless `opts.lookup` is given. A redirect
 * with no Location header is returned as is.
 */
export async function safeFetch(
  ctx: Pick<AdapterContext, "fetch" | "userAgent" | "skipRobotsCheck" | "robotsCheck">,
  url: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {}
): Promise<Response> {
  const fetchImpl = ctxFetch(ctx);
  const checkDns = ctx.fetch === undefined || opts.lookup !== undefined;
  const vet = async (target: string) => {
    const u = assertPublicHttpUrl(target);
    if (checkDns) await assertPublicHost(u.hostname, opts.lookup);
  };

  if (opts.guardInitial) await vet(url);
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers?.get?.("location");
    if (!location) return res;
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (more than ${MAX_REDIRECTS}) from ${url}`);
    const next = new URL(location, current).toString();
    await vet(next);
    if (!(await robotsAllows(next, ctx))) throw new Error(`redirect to ${next} is disallowed by robots.txt`);
    current = next;
  }
}
