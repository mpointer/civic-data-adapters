import { describe, it, expect, vi } from "vitest";
import { safeFetch, assertPublicHost } from "./internal.js";
import { runAdapter } from "./registry.js";
import { MemorySink } from "./types.js";
import type { AdapterContext } from "./types.js";

const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
const ok = (body = "ok") => new Response(body);

/** A fetch that serves a scripted map of url -> Response, recording each call. */
function scripted(routes: Record<string, () => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const make = routes[url];
    if (!make) throw new Error(`unexpected request to ${url}`);
    return make();
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

describe("safeFetch redirects", () => {
  it("passes a plain response straight through and asks for manual redirect handling", async () => {
    const s = scripted({ "https://a.example.gov/x": () => ok("hi") });
    const res = await safeFetch({ fetch: s.fetch, skipRobotsCheck: true }, "https://a.example.gov/x", { headers: { "User-Agent": "t" } });
    expect(await res.text()).toBe("hi");
    expect(s.calls[0]?.init).toMatchObject({ redirect: "manual", headers: { "User-Agent": "t" } });
  });

  it("follows relative and absolute redirects to the final response", async () => {
    const s = scripted({
      "https://a.example.gov/x": () => redirect("/y", 301),
      "https://a.example.gov/y": () => redirect("https://b.example.gov/z", 307),
      "https://b.example.gov/z": () => ok("final"),
    });
    const res = await safeFetch({ fetch: s.fetch, skipRobotsCheck: true }, "https://a.example.gov/x");
    expect(await res.text()).toBe("final");
    expect(s.calls.map((c) => c.url)).toEqual(["https://a.example.gov/x", "https://a.example.gov/y", "https://b.example.gov/z"]);
  });

  it.each([
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "http://localhost:8080/admin"],
    ["a private range", "http://10.0.0.5/"],
    ["an IPv6 loopback", "http://[::1]/"],
    ["an internal name", "https://db.internal/"],
    ["a non-http scheme", "file:///etc/passwd"],
  ])("refuses a redirect to %s without requesting it", async (_label, target) => {
    const s = scripted({ "https://a.example.gov/x": () => redirect(target) });
    await expect(safeFetch({ fetch: s.fetch, skipRobotsCheck: true }, "https://a.example.gov/x")).rejects.toThrow(/blocked/);
    expect(s.calls).toHaveLength(1);
  });

  it("refuses a redirect to a host that resolves to a private address", async () => {
    const s = scripted({ "https://a.example.gov/x": () => redirect("https://evil.example.com/") });
    const lookup = vi.fn(async () => ["93.184.216.34", "10.1.2.3"]);
    await expect(safeFetch({ fetch: s.fetch, skipRobotsCheck: true }, "https://a.example.gov/x", {}, { lookup })).rejects.toThrow(/resolves to private address 10\.1\.2\.3/);
    expect(lookup).toHaveBeenCalledWith("evil.example.com");
    expect(s.calls).toHaveLength(1);
  });

  it("allows a redirect whose host resolves only to public addresses", async () => {
    const s = scripted({ "https://a.example.gov/x": () => redirect("https://b.example.com/"), "https://b.example.com/": () => ok("fine") });
    const res = await safeFetch({ fetch: s.fetch, skipRobotsCheck: true }, "https://a.example.gov/x", {}, { lookup: async () => ["93.184.216.34"] });
    expect(await res.text()).toBe("fine");
  });

  it("does not block when the name cannot be resolved here (the fetch will report it)", async () => {
    await expect(assertPublicHost("nowhere.example", async () => { throw new Error("ENOTFOUND"); })).resolves.toBeUndefined();
  });

  it("stops after 5 redirects, and on a loop", async () => {
    const chain = scripted(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`https://a.example.gov/${i}`, () => redirect(`/${i + 1}`)])));
    await expect(safeFetch({ fetch: chain.fetch, skipRobotsCheck: true }, "https://a.example.gov/0")).rejects.toThrow(/too many redirects/);
    expect(chain.calls).toHaveLength(6);
    const loop = scripted({ "https://a.example.gov/a": () => redirect("/b"), "https://a.example.gov/b": () => redirect("/a") });
    await expect(safeFetch({ fetch: loop.fetch, skipRobotsCheck: true }, "https://a.example.gov/a")).rejects.toThrow(/too many redirects/);
  });

  it("checks robots.txt for the redirect target", async () => {
    const s = scripted({ "https://a.example.gov/x": () => redirect("https://b.example.gov/private") });
    const robotsCheck = vi.fn(async (u: string) => !u.includes("/private"));
    await expect(safeFetch({ fetch: s.fetch, robotsCheck }, "https://a.example.gov/x")).rejects.toThrow(/disallowed by robots\.txt/);
    expect(robotsCheck).toHaveBeenCalledWith("https://b.example.gov/private");
    expect(s.calls).toHaveLength(1);
  });

  it("returns a redirect with no Location as is", async () => {
    const s = scripted({ "https://a.example.gov/x": () => new Response(null, { status: 302 }) });
    const res = await safeFetch({ fetch: s.fetch, skipRobotsCheck: true }, "https://a.example.gov/x");
    expect(res.status).toBe(302);
  });

  it("can also vet the first URL (for URLs an LLM chose)", async () => {
    const s = scripted({ "https://sneaky.example.com/": () => ok() });
    await expect(
      safeFetch({ fetch: s.fetch, skipRobotsCheck: true }, "https://sneaky.example.com/", {}, { lookup: async () => ["127.0.0.1"], guardInitial: true })
    ).rejects.toThrow(/private address 127\.0\.0\.1/);
    expect(s.calls).toHaveLength(0);
    await expect(safeFetch({ fetch: s.fetch, skipRobotsCheck: true }, "http://169.254.169.254/", {}, { guardInitial: true })).rejects.toThrow(/blocked host/);
  });
});

describe("adapters follow redirects safely", () => {
  const ctxFor = (fetchImpl: typeof fetch): AdapterContext => ({ sink: new MemorySink(), logger: { log: vi.fn() }, skipRobotsCheck: true, fetch: fetchImpl });
  const table = `<table><tr><th>Date</th><th>Offense</th></tr><tr><td>03/01/2026</td><td>Theft</td></tr><tr><td>03/02/2026</td><td>Fraud</td></tr></table>`;

  it("blotter_html follows a redirect to the real page", async () => {
    const s = scripted({ "https://pd.example.gov/old": () => redirect("/blotter"), "https://pd.example.gov/blotter": () => ok(table) });
    const r = await runAdapter({ name: "X" }, { id: 1 }, { provider: "blotter_html", url: "https://pd.example.gov/old" }, ctxFor(s.fetch));
    expect(r).toMatchObject({ status: "ok", inserted: 2 });
  });

  it("blotter_html fails, and never requests the target, when redirected to cloud metadata", async () => {
    const s = scripted({ "https://pd.example.gov/b": () => redirect("http://169.254.169.254/latest/meta-data/iam/") });
    const r = await runAdapter({ name: "X" }, { id: 1 }, { provider: "blotter_html", url: "https://pd.example.gov/b" }, ctxFor(s.fetch));
    expect(r.status).toBe("failed");
    expect(r.problems.join()).toContain("blocked host 169.254.169.254");
    expect(s.calls).toHaveLength(1);
  });

  it("blotter_pdf and html_minutes are guarded the same way", async () => {
    const evil = "http://127.0.0.1:9/x";
    const s = scripted({ "https://pd.example.gov/b.pdf": () => redirect(evil), "https://m.example.gov/m": () => redirect(evil) });
    const pdf = await runAdapter({ name: "X" }, { id: 1 }, { provider: "blotter_pdf", url: "https://pd.example.gov/b.pdf" }, ctxFor(s.fetch));
    expect(pdf.status).toBe("failed");
    const min = await runAdapter({ name: "X" }, { id: 1 }, { provider: "html_minutes", url: "https://m.example.gov/m" }, { ...ctxFor(s.fetch), summarize: async () => "[]" });
    expect(min.status).toBe("failed");
    expect(s.calls.every((c) => !c.url.includes("127.0.0.1"))).toBe(true);
  });
});
