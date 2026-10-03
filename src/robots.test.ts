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
