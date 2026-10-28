import { describe, it, expect, vi } from "vitest";
import { discoverBlotter } from "./blotter.js";
import type { DiscoveryContext, Locality } from "../types.js";

const locality: Locality = { name: "Exampleville, PA", state: "PA" };

// Minimal HTML that parseBlotterHtml accepts: one <table> with a header row
// plus 2+ data rows whose headers match the column-guess keywords.
const BLOTTER_HTML = `
<html><body>
<table>
  <tr><th>Date</th><th>Offense</th><th>Location</th><th>Case Number</th></tr>
  <tr><td>07/20/2026</td><td>Theft</td><td>100 Main St</td><td>26-0123</td></tr>
  <tr><td>07/21/2026</td><td>Vandalism</td><td>200 Oak Ave</td><td>26-0124</td></tr>
</table>
</body></html>`;

const GOOD_URL = "https://pd.exampleville.gov/blotter";
const DEAD_URL = "https://pd.exampleville.gov/old-blotter";

function makeCtx(urls: string[]) {
  const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = String(input);
    if (url === GOOD_URL) {
      return { ok: true, text: async () => BLOTTER_HTML } as unknown as Response;
    }
    return { ok: false, status: 404 } as unknown as Response;
  });
  const log = vi.fn();
  const ctx: DiscoveryContext = {
    generate: vi.fn(async () => `\`\`\`json\n${JSON.stringify(urls.map((u) => ({ url: u })))}\n\`\`\``),
    fetch: fetchMock as unknown as typeof fetch,
    logger: { log },
    skipRobotsCheck: true,
    userAgent: "test-agent/1.0",
  };
  return { ctx, fetchMock, log };
}

describe("discoverBlotter propose→verify", () => {
  it("returns exactly the candidate that parses, with row-count evidence", async () => {
    const { ctx, fetchMock } = makeCtx([DEAD_URL, GOOD_URL]);

    const sources = await discoverBlotter(locality, ctx);

    expect(sources).toHaveLength(1);
    const src = sources[0]!;
    expect(src.provider).toBe("blotter_html");
    expect(src.url).toBe(GOOD_URL);
    expect(src.meta).toEqual({
      provider: "blotter_html",
      url: GOOD_URL,
      recordType: "police_blotter",
    });
    expect(src.evidence).toContain("2");
    expect(src.evidence.toLowerCase()).toContain("rows");
    expect(src.name).toContain("Exampleville");

    // The dead candidate was actually tried (HTML then PDF fallback) before
    // the good one verified.
    const fetched = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetched.filter((u) => u === DEAD_URL)).toHaveLength(2);
    expect(fetched.filter((u) => u === GOOD_URL)).toHaveLength(1);

    // Verification used the injected fetch with the ctx User-Agent.
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ "User-Agent": "test-agent/1.0" });
    }
  });

  it("returns [] when no candidate verifies", async () => {
    const { ctx, log } = makeCtx([DEAD_URL]);
    expect(await discoverBlotter(locality, ctx)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("candidate(s) verified"), "warn");
  });

  it("returns [] without fetching when the LLM proposes nothing", async () => {
    const { ctx, fetchMock } = makeCtx([]);
    ctx.generate = vi.fn(async () => "No blotters found, sorry.");
    expect(await discoverBlotter(locality, ctx)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("discoverBlotter optional verify gate", () => {
  it("accepts a confident yes and records the score as evidence", async () => {
    const { ctx } = makeCtx([GOOD_URL]);
    const verify = vi.fn(async () => 0.93);
    ctx.verify = verify;
    const sources = await discoverBlotter(locality, ctx);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.evidence).toContain("verify: 0.93");
    expect(sources[0]?.needsReview).toBeUndefined();
    // The verifier saw parsed row text, not raw HTML.
    const [question, text] = verify.mock.calls[0] as unknown as [string, string];
    expect(question).toContain("police incidents");
    expect(text).toContain("Theft");
    expect(text).not.toContain("<table");
  });

  it("rejects a confident no", async () => {
    const { ctx, log } = makeCtx([GOOD_URL]);
    ctx.verify = vi.fn(async () => 0.05);
    expect(await discoverBlotter(locality, ctx)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("verify rejected"), "warn");
  });

  it("treats the boundaries as inclusive: 0.7 accepts, 0.3 rejects", async () => {
    const a = makeCtx([GOOD_URL]);
    a.ctx.verify = vi.fn(async () => 0.7);
    expect((await discoverBlotter(locality, a.ctx))[0]?.needsReview).toBeUndefined();
    const b = makeCtx([GOOD_URL]);
    b.ctx.verify = vi.fn(async () => 0.3);
    expect(await discoverBlotter(locality, b.ctx)).toEqual([]);
  });

  it("returns an uncertain score flagged needsReview", async () => {
    const { ctx } = makeCtx([GOOD_URL]);
    ctx.verify = vi.fn(async () => 0.5);
    const sources = await discoverBlotter(locality, ctx);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.needsReview).toBe(true);
    expect(sources[0]?.evidence).toContain("needs review");
  });

  it("prefers a later confident candidate over an earlier uncertain one", async () => {
    const { ctx } = makeCtx([GOOD_URL, GOOD_URL + "?page=2"]);
    ctx.fetch = (async () => ({ ok: true, text: async () => BLOTTER_HTML }) as unknown as Response) as typeof fetch;
    let n = 0;
    ctx.verify = vi.fn(async () => (n++ === 0 ? 0.5 : 0.9));
    const sources = await discoverBlotter(locality, ctx);
    expect(sources[0]?.url).toBe(GOOD_URL + "?page=2");
    expect(sources[0]?.needsReview).toBeUndefined();
  });

  it("falls through to the next candidate after a rejection", async () => {
    const { ctx } = makeCtx([GOOD_URL, GOOD_URL + "?page=2"]);
    ctx.fetch = (async () => ({ ok: true, text: async () => BLOTTER_HTML }) as unknown as Response) as typeof fetch;
    let n = 0;
    ctx.verify = vi.fn(async () => (n++ === 0 ? 0.1 : 0.9));
    const sources = await discoverBlotter(locality, ctx);
    expect(sources[0]?.url).toBe(GOOD_URL + "?page=2");
  });

  it("honours custom thresholds", async () => {
    const { ctx } = makeCtx([GOOD_URL]);
    ctx.verify = vi.fn(async () => 0.6);
    ctx.verifyThresholds = { yes: 0.55 };
    expect((await discoverBlotter(locality, ctx))[0]?.needsReview).toBeUndefined();
  });

  it("ignores inverted thresholds and warns", async () => {
    const { ctx, log } = makeCtx([GOOD_URL]);
    ctx.verify = vi.fn(async () => 0.5);
    ctx.verifyThresholds = { yes: 0.2, no: 0.8 };
    const sources = await discoverBlotter(locality, ctx);
    expect(sources[0]?.needsReview).toBe(true); // defaults 0.7/0.3 applied
    expect(log).toHaveBeenCalledWith(expect.stringContaining("verifyThresholds"), "warn");
  });

  it("fails open when verify throws", async () => {
    const { ctx, log } = makeCtx([GOOD_URL]);
    ctx.verify = vi.fn(async () => {
      throw new Error("quota");
    });
    const sources = await discoverBlotter(locality, ctx);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.needsReview).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("verify failed"), "warn");
  });

  it.each([NaN, 1.5, -0.1, "0.9" as unknown as number])(
    "fails open on an invalid score (%s)",
    async (bad) => {
      const { ctx, log } = makeCtx([GOOD_URL]);
      ctx.verify = vi.fn(async () => bad);
      const sources = await discoverBlotter(locality, ctx);
      expect(sources).toHaveLength(1);
      expect(sources[0]?.needsReview).toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("verify failed"), "warn");
    }
  );

  it("is a no-op when verify is not provided", async () => {
    const { ctx } = makeCtx([GOOD_URL]);
    const sources = await discoverBlotter(locality, ctx);
    expect(sources[0]?.evidence).toBe("parsed 2 HTML blotter rows just now");
    expect(sources[0]?.needsReview).toBeUndefined();
  });
});
