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
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
      expect((call[1] as RequestInit).headers).toMatchObject({ "User-Agent": "test-agent/1.0" });
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

describe("discoverBlotter optional classify gate", () => {
  it("accepts when the classifier agrees, and records its confidence as evidence", async () => {
    const { ctx } = makeCtx([GOOD_URL]);
    const classify = vi.fn(async () => ({ label: "police_blotter", probability: 0.93 }));
    ctx.classify = classify;
    const sources = await discoverBlotter(locality, ctx);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.evidence).toContain("classifier: police_blotter 0.93");
    // The classifier saw parsed row text, not raw HTML.
    const [task, text, labels] = classify.mock.calls[0] as unknown as [string, string, string[]];
    expect(task).toContain("police incidents");
    expect(text).toContain("Theft");
    expect(text).not.toContain("<table");
    expect(labels).toEqual(["police_blotter", "other"]);
  });

  it("rejects a candidate the parsers accepted but the classifier calls something else", async () => {
    const { ctx, log } = makeCtx([GOOD_URL]);
    ctx.classify = vi.fn(async () => ({ label: "other", probability: 0.97 }));
    expect(await discoverBlotter(locality, ctx)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("classifier rejected"), "warn");
  });

  it("rejects a low-confidence blotter verdict", async () => {
    const { ctx } = makeCtx([GOOD_URL]);
    ctx.classify = vi.fn(async () => ({ label: "police_blotter", probability: 0.4 }));
    expect(await discoverBlotter(locality, ctx)).toEqual([]);
  });

  it("falls through to the next candidate when the first is rejected", async () => {
    const { ctx } = makeCtx([GOOD_URL, GOOD_URL + "?page=2"]);
    ctx.fetch = (async () => ({ ok: true, text: async () => BLOTTER_HTML }) as unknown as Response) as typeof fetch;
    let n = 0;
    ctx.classify = vi.fn(async () => (n++ === 0 ? { label: "other", probability: 0.9 } : { label: "police_blotter", probability: 0.9 }));
    const sources = await discoverBlotter(locality, ctx);
    expect(sources[0]?.url).toBe(GOOD_URL + "?page=2");
  });

  it("fails open when the classifier throws", async () => {
    const { ctx, log } = makeCtx([GOOD_URL]);
    ctx.classify = vi.fn(async () => {
      throw new Error("quota");
    });
    const sources = await discoverBlotter(locality, ctx);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.evidence).not.toContain("classifier");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("classifier failed"), "warn");
  });

  it("is a no-op when classify is not provided", async () => {
    const { ctx } = makeCtx([GOOD_URL]);
    const sources = await discoverBlotter(locality, ctx);
    expect(sources[0]?.evidence).toBe("parsed 2 HTML blotter rows just now");
  });
});
