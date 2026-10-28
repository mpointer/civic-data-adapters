import { describe, it, expect, vi } from "vitest";
import { assertPublicHttpUrl } from "./internal.js";
import { discoverBlotter, fetchCrimewatchIncidents } from "./index.js";
import type { DiscoveryContext } from "./types.js";

describe("assertPublicHttpUrl", () => {
  const blocked = [
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://localhost:6379/",
    "http://app.localhost/",
    "http://127.0.0.1/",
    "http://10.0.0.5:8080/admin",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://100.64.0.1/", // carrier-grade NAT
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://db.internal/",
    "http://printer.local/",
    "file:///etc/passwd",
    "ftp://pd.example.gov/blotter",
    "gopher://pd.example.gov/",
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(() => assertPublicHttpUrl(url)).toThrow(/blocked/);
    });
  }

  const allowed = [
    "https://pd.exampleville.gov/blotter",
    "http://pd.exampleville.gov/blotter.pdf",
    "https://8.8.8.8/x",
    "https://172.32.0.1/x", // just outside 172.16/12
    "https://crimewatch.net/us/pa/x/incidents",
  ];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(assertPublicHttpUrl(url).href).toContain("://");
    });
  }

  it("rejects strings that are not URLs", () => {
    expect(() => assertPublicHttpUrl("not a url")).toThrow();
  });
});

describe("discoverBlotter refuses non-public candidates", () => {
  it("never makes a request to an address the LLM proposes inside the network", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    const log = vi.fn();
    const ctx: DiscoveryContext = {
      generate: async () =>
        JSON.stringify([
          { url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" },
          { url: "http://localhost:6379/" },
          { url: "http://10.0.0.5:8080/admin/delete-all" },
        ]),
      fetch: fetchMock as unknown as typeof fetch,
      logger: { log },
    };
    const found = await discoverBlotter({ name: "Exampleville, PA" }, ctx);
    expect(found).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled(); // not even robots.txt
    expect(log).toHaveBeenCalledWith(expect.stringContaining("non-public"), "warn");
  });

  it("still verifies a public candidate that follows a rejected one", async () => {
    const table =
      "<table><tr><th>Date</th><th>Offense</th><th>Location</th></tr>" +
      "<tr><td>03/04/2026</td><td>Theft</td><td>100 Main St</td></tr>" +
      "<tr><td>03/05/2026</td><td>Noise</td><td>200 Oak Ave</td></tr></table>";
    const fetchMock = vi.fn(async (input: unknown) =>
      String(input).endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(table),
    );
    const ctx: DiscoveryContext = {
      generate: async () => JSON.stringify([{ url: "http://localhost:9/x" }, { url: "https://pd.exampleville.gov/blotter" }]),
      fetch: fetchMock as unknown as typeof fetch,
    };
    const found = await discoverBlotter({ name: "Exampleville, PA" }, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.url).toBe("https://pd.exampleville.gov/blotter");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("localhost"))).toBe(false);
  });
});

describe("CrimeWatch does not let the page choose where requests go", () => {
  const page = (sitePath: string) =>
    "<script>jQuery.extend(Drupal.settings, " +
    JSON.stringify({ cw_web: { api_key: "k", site_path: sitePath, base_path: "/", feed: { data: { gid: "1" } } } }) +
    ");</script>";
  const run = async (pageUrl: string, sitePath: string) => {
    const urls: string[] = [];
    const fetchMock = (async (input: unknown, init?: RequestInit) => {
      const u = String(input);
      urls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.includes("services/session/token")) return new Response("tok");
      if (u.includes("api/cw_web/feed")) {
        const { bundle, page: pageNo } = JSON.parse(String(init?.body)) as { bundle: string; page: number };
        const results = bundle === "incident" && pageNo === 0 ? [{ nid: 1, title: "T", body: "b" }] : [];
        return new Response(JSON.stringify({ results, page: pageNo, pages: 1, count: results.length }));
      }
      return new Response(page(sitePath));
    }) as unknown as typeof fetch;
    const incidents = await fetchCrimewatchIncidents(pageUrl, { fetch: fetchMock, skipRobotsCheck: true });
    return { incidents, urls };
  };

  it("ignores a page that points its API at a foreign host", async () => {
    const { incidents, urls } = await run("https://crimewatch.net/us/pa/x/incidents", "https://evil.example.org");
    expect(incidents).toEqual([]);
    expect(urls).toEqual(["GET https://crimewatch.net/us/pa/x/incidents"]); // no token request, no POST
  });

  it("ignores a page that points its API at an internal address", async () => {
    const { incidents, urls } = await run("https://crimewatch.net/us/pa/x/incidents", "http://169.254.169.254");
    expect(incidents).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it("accepts the platform's own domains", async () => {
    const { incidents } = await run("https://town.crimewatchpa.com/incidents", "https://town.crimewatchpa.com");
    expect(incidents).toHaveLength(1);
  });

  it("accepts an API on the same host as the page (custom-domain deployments)", async () => {
    const { incidents } = await run("https://police.townofexample.org/incidents", "https://police.townofexample.org");
    expect(incidents).toHaveLength(1);
  });
});
