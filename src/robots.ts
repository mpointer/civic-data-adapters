// Shared robots.txt compliance check, added after an audit of the original
// pipeline found that none of its scrapers checked robots.txt before fetching
// a source. Follows RFC 9309 for what it implements: Allow/Disallow with `*`
// wildcards and the `$` end anchor, the longest matching rule wins, and Allow
// wins a tie. Ignores crawl-delay and sitemap directives. A 4xx robots.txt means
// "no rules"; a 5xx is treated as a complete disallow (briefly cached). A
// network error still fails OPEN, a deliberate choice documented in the README:
// a flaky robots.txt fetch shouldn't halt ingestion, though RFC 9309 would
// disallow here too.

import { readText } from "./body.js";

const DEFAULT_UA_TOKEN = "civic-data-adapters";
const ERROR_CACHE_TTL_MS = 5 * 60 * 1000; // a 5xx is usually transient: re-check soon
const MAX_ROBOTS_BYTES = 512 * 1024; // RFC 9309: parse at least 500 KiB, no need for more
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — same robots.txt for many fetches in one run

export interface Rule {
  prefix: string;
  allow: boolean;
}

interface CacheEntry {
  rules: Rule[];
  fetchedAt: number;
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();

interface Group {
  agents: string[];
  rules: Rule[];
}

// Groups consecutive User-agent lines (a group can name several agents
// before its directives) with the Allow/Disallow lines that follow, per the
// robots.txt spec's block structure.
function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let inAgentRun = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = (rawLine.split("#")[0] ?? "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!inAgentRun || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      inAgentRun = true;
      continue;
    }
    inAgentRun = false;
    if (!current) continue;

    if (field === "disallow" && value) current.rules.push({ prefix: value, allow: false });
    else if (field === "allow" && value) current.rules.push({ prefix: value, allow: true });
  }

  return groups;
}

// Per the robots.txt spec, a crawler uses the single most specific group
// that names it — never merging it with the wildcard group. Only falls back
// to "*" groups when no group names us specifically anywhere in the file.
export function parseRobotsTxt(text: string, uaToken: string = DEFAULT_UA_TOKEN): Rule[] {
  const groups = parseGroups(text);
  const token = uaToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a.includes(token)));
  const applicable = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return applicable.flatMap((g) => g.rules);
}

export interface RobotsCheckOptions {
  /** Token matched against robots.txt User-agent lines. */
  uaToken?: string;
  /** Override fetch (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Full User-Agent header sent when fetching robots.txt itself. */
  userAgent?: string;
}

async function getRules(origin: string, options: RobotsCheckOptions): Promise<Rule[]> {
  const uaToken = options.uaToken ?? DEFAULT_UA_TOKEN;
  const cacheKey = `${uaToken}\0${origin}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < cached.ttlMs) return cached.rules;

  const fetchImpl = options.fetch ?? fetch;
  let rules: Rule[] = [];
  let ttlMs = CACHE_TTL_MS;
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: {
        "User-Agent":
          options.userAgent ?? `${uaToken}/0.1 (+https://github.com/mpointer/civic-data-adapters)`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      rules = parseRobotsTxt(await readText(res, MAX_ROBOTS_BYTES, { truncate: true }), uaToken);
    } else if (res.status >= 500) {
      rules = [{ prefix: "/", allow: false }]; // server in trouble: assume disallow
      ttlMs = ERROR_CACHE_TTL_MS;
    }
    // 4xx: no robots.txt, so no rules
  } catch {
    rules = []; // fail open: no rules means nothing is disallowed
  }

  cache.set(cacheKey, { rules, fetchedAt: Date.now(), ttlMs });
  return rules;
}

// `*` matches any run of characters and a trailing `$` anchors the end. Done
// with indexOf, not a regex built from the pattern: robots.txt is controlled by
// the site, and a pattern like /*a*a*a*b would make a backtracking regex hang.
function matchesRule(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0] ?? "";
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return anchored ? path === first : true;
  let pos = first.length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i === parts.length - 1 && anchored) {
      return part === "" || (path.length - part.length >= pos && path.endsWith(part));
    }
    const idx = path.indexOf(part, pos);
    if (idx === -1) return false;
    pos = idx + part.length;
  }
  return true;
}

// The longest matching rule wins (the most specific); on a tie Allow wins, so
// the result does not depend on the order of lines in the file. No matching
// rule means allowed (robots.txt is opt-out, not opt-in).
export function isPathAllowed(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!matchesRule(rule.prefix, path)) continue;
    if (
      !best ||
      rule.prefix.length > best.prefix.length ||
      (rule.prefix.length === best.prefix.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

// Returns true if we are allowed to fetch `url`. Fails open (returns true)
// on any network/parse error, or if the URL itself can't be parsed.
export async function isAllowedByRobots(
  url: string,
  options: RobotsCheckOptions = {}
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const rules = await getRules(parsed.origin, options);
  if (rules.length === 0) return true;
  return isPathAllowed(rules, parsed.pathname + parsed.search);
}
