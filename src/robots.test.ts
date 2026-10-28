import { describe, it, expect } from "vitest";
import { parseRobotsTxt, isPathAllowed, isAllowedByRobots } from "./robots.js";

const fakeFetch = (body: string | Error, status = 200) =>
  (async () => {
    if (body instanceof Error) throw body;
    return new Response(body, { status });
  }) as unknown as typeof fetch;

describe("parseRobotsTxt + isPathAllowed", () => {
  it("applies the longest matching prefix, Allow beating a shorter Disallow", () => {
    const rules = parseRobotsTxt("User-agent: *\nDisallow: /private\nAllow: /private/public");
    expect(isPathAllowed(rules, "/private/x")).toBe(false);
    expect(isPathAllowed(rules, "/private/public/x")).toBe(true);
    expect(isPathAllowed(rules, "/other")).toBe(true);
  });

  it("ignores groups for other user agents and comments", () => {
    const rules = parseRobotsTxt("User-agent: googlebot\nDisallow: /\n\nUser-agent: *\n# c\nDisallow: /tmp");
    expect(isPathAllowed(rules, "/")).toBe(true);
    expect(isPathAllowed(rules, "/tmp/a")).toBe(false);
  });

  it("treats an empty Disallow as allow-all", () => {
    expect(isPathAllowed(parseRobotsTxt("User-agent: *\nDisallow:"), "/anything")).toBe(true);
  });
});

describe("isAllowedByRobots", () => {
  it("blocks disallowed paths and allows others", async () => {
    const f = fakeFetch("User-agent: *\nDisallow: /blotter");
    expect(await isAllowedByRobots("https://r1.example.gov/blotter/today", { fetch: f })).toBe(false);
    expect(await isAllowedByRobots("https://r1.example.gov/news", { fetch: f })).toBe(true);
  });

  it("fails open on network errors, 404s, and unparseable URLs", async () => {
    expect(await isAllowedByRobots("https://r2.example.gov/x", { fetch: fakeFetch(new Error("down")) })).toBe(true);
    expect(await isAllowedByRobots("https://r3.example.gov/x", { fetch: fakeFetch("", 404) })).toBe(true);
    expect(await isAllowedByRobots("::not a url::")).toBe(true);
  });

  it("caches per origin (second call doesn't refetch)", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response("User-agent: *\nDisallow: /a");
    }) as unknown as typeof fetch;
    await isAllowedByRobots("https://r4.example.gov/a", { fetch: f });
    await isAllowedByRobots("https://r4.example.gov/b", { fetch: f });
    expect(calls).toBe(1);
  });
});

describe("robots.txt wildcard and precedence rules (RFC 9309)", () => {
  const rules = (...entries: string[]) => entries.map((e) => ({ allow: e.startsWith("+"), prefix: e.slice(1) }));

  it("supports * wildcards", () => {
    expect(isPathAllowed(rules("-/*?"), "/blotter?page=2")).toBe(false);
    expect(isPathAllowed(rules("-/*?"), "/blotter")).toBe(true);
    expect(isPathAllowed(rules("-/a*c"), "/abbbc/x")).toBe(false);
    expect(isPathAllowed(rules("-/a*c"), "/abbb/x")).toBe(true);
    expect(isPathAllowed(rules("-/*/private/"), "/city/private/x")).toBe(false);
  });

  it("supports the $ end anchor", () => {
    expect(isPathAllowed(rules("-/*.pdf$"), "/a/b.pdf")).toBe(false);
    expect(isPathAllowed(rules("-/*.pdf$"), "/a/b.pdf?download=1")).toBe(true);
    expect(isPathAllowed(rules("-/exact$"), "/exact")).toBe(false);
    expect(isPathAllowed(rules("-/exact$"), "/exact/more")).toBe(true);
    expect(isPathAllowed(rules("-/*$"), "/anything")).toBe(false);
  });

  it("lets the longest matching rule win, and Allow win a tie regardless of order", () => {
    expect(isPathAllowed(rules("-/p", "+/p/public"), "/p/public/a")).toBe(true);
    expect(isPathAllowed(rules("-/blotter", "+/blotter"), "/blotter/x")).toBe(true);
    expect(isPathAllowed(rules("+/blotter", "-/blotter"), "/blotter/x")).toBe(true);
  });

  it("cannot be made to backtrack catastrophically by a hostile robots.txt", () => {
    const evil = rules("-/" + "*a".repeat(40) + "b");
    const start = performance.now();
    expect(isPathAllowed(evil, "/" + "a".repeat(5000))).toBe(true);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("treats a 5xx robots.txt as a complete disallow (the server said it is in trouble)", async () => {
    expect(await isAllowedByRobots("https://r10.example.gov/anything", { fetch: fakeFetch("Service Unavailable", 503) })).toBe(false);
    expect(await isAllowedByRobots("https://r11.example.gov/anything", { fetch: fakeFetch("", 500) })).toBe(false);
  });

  it("still treats a missing (4xx) robots.txt as allow-all, and a network error as allow (documented fail-open)", async () => {
    expect(await isAllowedByRobots("https://r12.example.gov/x", { fetch: fakeFetch("", 404) })).toBe(true);
    expect(await isAllowedByRobots("https://r13.example.gov/x", { fetch: fakeFetch("", 403) })).toBe(true);
    expect(await isAllowedByRobots("https://r14.example.gov/x", { fetch: fakeFetch(new Error("down")) })).toBe(true);
  });

  it("applies wildcard rules end to end", async () => {
    const f = fakeFetch("User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?");
    expect(await isAllowedByRobots("https://r15.example.gov/blotter/today.pdf", { fetch: f })).toBe(false);
    expect(await isAllowedByRobots("https://r15.example.gov/blotter?page=2", { fetch: f })).toBe(false);
    expect(await isAllowedByRobots("https://r15.example.gov/blotter", { fetch: f })).toBe(true);
  });

  it("does not hold a transient 5xx against a site for the full cache lifetime", async () => {
    let status = 503;
    const f = (async () => new Response("User-agent: *\nDisallow:", { status })) as unknown as typeof fetch;
    expect(await isAllowedByRobots("https://r16.example.gov/x", { fetch: f })).toBe(false);
    status = 200;
    // an error result is cached only briefly; advance the clock past that window
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60_000;
    try {
      expect(await isAllowedByRobots("https://r16.example.gov/x", { fetch: f })).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});
