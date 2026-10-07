import { describe, it, expect, vi } from "vitest";
import { ingestCrimewatchBlotter, fetchCrimewatchIncidents, isCrimewatchUrl } from "./blotter-crimewatch.js";
import { MemorySink } from "../types.js";
import type { AdapterContext } from "../types.js";

// SYNTHETIC page + API shapes reconstructed from the adapter's documented
// contract (Drupal.settings embed, session token, POST feed). Not captured
// from a live CrimeWatch site; they guard the parsing logic, not CrimeWatch's
// current markup.
const SETTINGS = {
  cw_web: {
    api_key: "pub-key",
    site_path: "https://crimewatch.net",
    base_path: "/",
    feed: { data: { gid: "42" } },
  },
};
// A later unrelated script block with a '});' must not confuse extraction,
// and braces inside strings must not unbalance the walk.
const PAGE = (settings: unknown) => `<html><script>
jQuery.extend(Drupal.settings, ${JSON.stringify({ ...(settings as object), note: "has } and { braces" })});
</script><script>widget({"lang":"en"});</script></html>`;

function feed(bundleResults: Record<string, unknown[]>, pages = 1) {
  return (bundle: string, page: number) => ({
    results: page === 0 || pages > 1 ? bundleResults[bundle] ?? [] : [],
    page,
    pages,
    count: (bundleResults[bundle] ?? []).length,
  });
}

function makeFetch(opts: { html?: string; token?: string | null; feedFn?: (b: string, p: number) => unknown }) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("services/session/token")) {
      return opts.token === null ? new Response("", { status: 403 }) : new Response(opts.token ?? "csrf-tok\n");
    }
    if (url.includes("api/cw_web/feed")) {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(opts.feedFn?.(body.bundle, body.page)));
    }
    return new Response(opts.html ?? PAGE(SETTINGS));
  });
}

const URL1 = "https://crimewatch.net/us/pa/county/town-pd/incidents";
const baseOpts = { skipRobotsCheck: true };

describe("isCrimewatchUrl", () => {
  it("matches crimewatch.net and *.crimewatchpa.com only", () => {
    expect(isCrimewatchUrl("https://crimewatch.net/us/pa/x")).toBe(true);
    expect(isCrimewatchUrl("https://town.crimewatchpa.com/x")).toBe(true);
    expect(isCrimewatchUrl("https://evilcrimewatch.net/x")).toBe(false);
    expect(isCrimewatchUrl("not a url")).toBe(false);
  });
});

describe("fetchCrimewatchIncidents", () => {
  it("returns [] when settings can't be found, the token fails, or the page errors", async () => {
    expect(await fetchCrimewatchIncidents(URL1, { ...baseOpts, fetch: makeFetch({ html: "<html>nothing</html>" }) as unknown as typeof fetch })).toEqual([]);
    expect(await fetchCrimewatchIncidents(URL1, { ...baseOpts, fetch: makeFetch({ token: null }) as unknown as typeof fetch })).toEqual([]);
    const missingGid = PAGE({ cw_web: { ...SETTINGS.cw_web, feed: {} } });
    expect(await fetchCrimewatchIncidents(URL1, { ...baseOpts, fetch: makeFetch({ html: missingGid }) as unknown as typeof fetch })).toEqual([]);
  });

  it("merges all four bundles, decodes entities, and converts timestamps", async () => {
    const created = Date.UTC(2026, 2, 4) / 1000;
    const f = makeFetch({
      feedFn: feed({
        incident: [{ nid: 1, title: "Theft", body: "Tom &amp; Jerry&nbsp;took  it", date: { created }, lat: "40.1", lng: "-79.9", group: { title: "Patrol" } }],
        arrest: [{ nid: 2, title: "Arrest", body: "" }],
        case: [],
        warrant: [{ nid: 3, title: "Warrant", body: "x" }],
      }),
    });
    const inc = await fetchCrimewatchIncidents(URL1, { ...baseOpts, fetch: f as unknown as typeof fetch });
    expect(inc.map((i) => i.nid)).toEqual([1, 2, 3]);
    expect(inc[0]).toMatchObject({ body: "Tom & Jerry took it", dateIso: "2026-03-04", lat: "40.1", groupTitle: "Patrol" });
    expect(inc[1]).toMatchObject({ dateIso: null, lat: null, groupTitle: null });
    // sends the token and key the page provided
    const feedCall = f.mock.calls.find((c) => String(c[0]).includes("api/cw_web/feed"));
    expect(String(feedCall?.[0])).toContain("api-key=pub-key");
    expect((feedCall?.[1]?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-tok");
  });

  it("honors robots.txt", async () => {
    const f = vi.fn(async (u: unknown) =>
      String(u).endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /") : new Response(PAGE(SETTINGS))
    );
    expect(await fetchCrimewatchIncidents("https://crimewatch.net/blocked-by-robots", { fetch: f as unknown as typeof fetch })).toEqual([]);
  });
});

describe("ingestCrimewatchBlotter", () => {
  const locality = { name: "Townsville" };

  it("ingests with nid-based dedupe and keeps lat/lng in raw", async () => {
    const sink = new MemorySink();
    const ctx: AdapterContext = {
      sink,
      skipRobotsCheck: true,
      fetch: makeFetch({ feedFn: feed({ incident: [{ nid: 99, title: "Burglary", body: "b", lat: "1", lng: "2" }] }) }) as unknown as typeof fetch,
    };
    const meta = { provider: "blotter_crimewatch", url: URL1 } as const;
    expect(await ingestCrimewatchBlotter(locality, { id: 1 }, meta, ctx)).toEqual({ inserted: 1, skipped: 0 });
    expect(sink.records.get("crimewatch:99")).toMatchObject({ type: "police_blotter", title: "Burglary", raw: { nid: 99, lat: "1", lng: "2" } });
    expect(await ingestCrimewatchBlotter(locality, { id: 1 }, meta, ctx)).toEqual({ inserted: 0, skipped: 1 });
  });

  it("warns on no url and on empty feeds", async () => {
    const log = vi.fn();
    const ctx: AdapterContext = { sink: new MemorySink(), logger: { log }, skipRobotsCheck: true, fetch: makeFetch({ feedFn: feed({}) }) as unknown as typeof fetch };
    await ingestCrimewatchBlotter(locality, { id: 1 }, { provider: "blotter_crimewatch" }, ctx);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no url"), "warn");
    await ingestCrimewatchBlotter(locality, { id: 1 }, { provider: "blotter_crimewatch", url: URL1 }, ctx);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no incidents parsed"), "warn");
  });
});
