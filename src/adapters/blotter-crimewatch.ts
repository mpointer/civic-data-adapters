// CrimeWatch (crimewatch.net / *.crimewatchpa.com) blotter adapter. CrimeWatch
// is a platform many Pennsylvania police departments publish on — a Drupal 7
// site whose incident blotter is client-side rendered, so it has no
// server-rendered <table> the generic blotter_html parser can see. This
// adapter instead calls the same JSON API the site's own frontend uses to
// render itself.
//
// Auth is a page-embedded, non-secret API key (shipped to every visitor's
// browser in Drupal.settings) plus a CSRF token from an unauthenticated GET —
// the same mechanism the public website itself uses for anonymous visitors,
// not a private/paid API. Confirmed live against a real department feed
// (2026-07-10): returns title, full teaser body, timestamps, and lat/lng —
// richer than anything the HTML/PDF adapters extract.
//
// Source metadata shape: { provider: "blotter_crimewatch", url: "https://crimewatch.net/us/pa/<county>/<dept>-pd/incidents" }
import type {
  Locality,
  CivicSource,
  MetaFor,
  AdapterContext,
  AdapterResult,
  CivicRecord,
} from "../types.js";
import { ctxFetch, ctxUserAgent, robotsAllows } from "../internal.js";

const MAX_PAGES = 10;

export function isCrimewatchUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "crimewatch.net" || host.endsWith(".crimewatchpa.com");
  } catch {
    return false;
  }
}

interface CrimewatchSettings {
  gid: string;
  apiKey: string;
  apiBase: string; // e.g. "https://crimewatch.net/"
}

// Drupal 7 emits its client-side config as `jQuery.extend(Drupal.settings, {...});`
// — a single JSON object literal (valid JSON, not JS-with-functions). The page
// has other unrelated `something({...});`-shaped script blocks later on (e.g.
// a language-switcher widget), so a regex matching to the LAST `});` on the
// page over-grabs; a real brace-depth walk from the opening `{` is required
// to find the actual matching close.
function extractJsonObject(text: string, startBrace: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startBrace; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startBrace, i + 1);
    }
  }
  return null;
}

function extractSettings(html: string): CrimewatchSettings | null {
  const anchor = html.indexOf("jQuery.extend(Drupal.settings,");
  if (anchor === -1) return null;
  const braceStart = html.indexOf("{", anchor);
  if (braceStart === -1) return null;
  const json = extractJsonObject(html, braceStart);
  if (!json) return null;

  let parsed: {
    cw_web?: { api_key?: string; site_path?: string; base_path?: string; feed?: { data?: { gid?: string } } };
  };
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const cw = parsed.cw_web;
  const gid = cw?.feed?.data?.gid;
  const apiKey = cw?.api_key;
  const sitePath = cw?.site_path;
  const basePath = cw?.base_path;
  if (!gid || !apiKey || !sitePath || !basePath) return null;
  return { gid, apiKey, apiBase: `${sitePath}${basePath}` };
}

export interface CrimewatchFetchOptions {
  fetch?: typeof fetch;
  userAgent?: string;
  skipRobotsCheck?: boolean;
}

async function getToken(apiBase: string, opts: CrimewatchFetchOptions): Promise<string | null> {
  try {
    const res = await ctxFetch(opts)(`${apiBase}services/session/token`, {
      headers: { "User-Agent": ctxUserAgent(opts) },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

// Common entities seen in CrimeWatch teaser bodies. No external dependency,
// matching the rest of the blotter-* adapters.
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export interface CrimewatchIncident {
  nid: number;
  title: string;
  body: string;
  dateIso: string | null;
  lat: string | null;
  lng: string | null;
  groupTitle: string | null;
}

interface FeedResponse {
  results: Array<{
    nid: number;
    title: string;
    body: string;
    date?: { created?: number };
    lat?: string;
    lng?: string;
    group?: { title?: string };
  }>;
  page: number;
  pages: number;
  count: number;
}

// Departments spread police-activity content across multiple CrimeWatch
// "bundles" rather than putting everything under one — confirmed live
// 2026-07-10: one department's "incident" bundle was stale (last post 82 days
// before this was tested) while its "arrest" and "case" bundles had content
// from the same week. Stopping at the first non-empty bundle (an earlier
// version of this adapter did exactly that) silently misses genuinely recent
// activity a department posted under a different category. Fetch and merge
// all four instead — the sink's dedupe on dedupeKey makes re-runs across
// overlapping bundles a no-op.
const BUNDLES = ["incident", "arrest", "case", "warrant"] as const;

async function fetchFeedPage(
  settings: CrimewatchSettings,
  token: string,
  bundle: string,
  page: number,
  opts: CrimewatchFetchOptions
): Promise<FeedResponse | null> {
  try {
    const res = await ctxFetch(opts)(
      `${settings.apiBase}api/cw_web/feed?api-key=${encodeURIComponent(settings.apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
          "User-Agent": ctxUserAgent(opts),
        },
        body: JSON.stringify({
          gid: settings.gid,
          page,
          pageSize: 10,
          bundle,
          teaserLength: 280, // server-enforced max; 406s above this
          sticky: 1,
          cache: 1,
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;
    return (await res.json()) as FeedResponse;
  } catch {
    return null;
  }
}

// Fetches the department's blotter page once to recover its gid/api key
// (self-healing if CrimeWatch ever rotates the key — no secrets persisted in
// source metadata), then paginates the real feed API. `maxPages=1` is enough
// to validate a candidate URL without pulling full history.
export async function fetchCrimewatchIncidents(
  url: string,
  options: CrimewatchFetchOptions = {},
  maxPages = MAX_PAGES
): Promise<CrimewatchIncident[]> {
  if (!(await robotsAllows(url, options))) return [];

  let html: string;
  try {
    const res = await ctxFetch(options)(url, {
      headers: { "User-Agent": ctxUserAgent(options) },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }

  const settings = extractSettings(html);
  if (!settings) return [];

  const token = await getToken(settings.apiBase, options);
  if (!token) return [];

  const incidents: CrimewatchIncident[] = [];
  const pushResults = (data: FeedResponse) => {
    for (const r of data.results ?? []) {
      incidents.push({
        nid: r.nid,
        title: r.title,
        body: decodeEntities(r.body ?? ""),
        dateIso: r.date?.created ? new Date(r.date.created * 1000).toISOString().slice(0, 10) : null,
        lat: r.lat ?? null,
        lng: r.lng ?? null,
        groupTitle: r.group?.title ?? null,
      });
    }
  };

  for (const bundle of BUNDLES) {
    const first = await fetchFeedPage(settings, token, bundle, 0, options);
    if (!first || first.count === 0) continue;

    pushResults(first);
    const totalPages = first.pages ?? 1;
    let page = 1;
    while (page < totalPages && page < maxPages) {
      await new Promise((r) => setTimeout(r, 300));
      const data = await fetchFeedPage(settings, token, bundle, page, options);
      if (!data) break;
      pushResults(data);
      page++;
    }
  }

  return incidents;
}

export async function ingestCrimewatchBlotter(
  locality: Locality,
  source: CivicSource,
  meta: MetaFor<"blotter_crimewatch">,
  ctx: AdapterContext
): Promise<AdapterResult> {
  const url = meta.url ?? source.url;
  if (!url) {
    await ctx.logger?.log(`[${locality.name}] blotter_crimewatch: no url in source metadata`, "warn");
    return { inserted: 0, skipped: 0 };
  }

  const incidents = await fetchCrimewatchIncidents(url, ctx);
  if (!incidents.length) {
    await ctx.logger?.log(
      `[${locality.name}] blotter_crimewatch: no incidents parsed from ${url}`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  const records: CivicRecord[] = [];

  for (const inc of incidents) {
    const details: Record<string, unknown> = { nid: inc.nid };
    if (inc.lat && inc.lng) {
      details.lat = inc.lat;
      details.lng = inc.lng;
    }
    if (inc.groupTitle) details.group = inc.groupTitle;

    records.push({
      provider: "blotter_crimewatch",
      type: "police_blotter",
      title: inc.title,
      summary: inc.body || null,
      date: inc.dateIso,
      url: null,
      // Drupal node id is unique across the CrimeWatch platform.
      dedupeKey: `crimewatch:${inc.nid}`,
      localityName: locality.name,
      sourceId: source.id,
      raw: details,
    });
  }

  const result = await ctx.sink.save(records);
  await ctx.logger?.log(
    `[${locality.name}] blotter_crimewatch: +${result.inserted} records, ${result.skipped} skipped from ${url}`
  );
  return result;
}
