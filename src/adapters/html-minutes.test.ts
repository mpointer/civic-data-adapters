import { describe, it, expect, vi } from "vitest";
import { ingestHtmlMinutes } from "./html-minutes.js";
import { MemorySink } from "../types.js";
import type { AdapterContext, Locality, CivicSource } from "../types.js";

const locality: Locality = { name: "Exampleville" };
const source: CivicSource = { id: 7 };
const PAGE = "<html><script>x()</script><body><h1>Minutes</h1><p>Motion to approve budget passed.</p></body></html>";

function setup(summarize?: AdapterContext["summarize"], html = PAGE) {
  const sink = new MemorySink();
  const log = vi.fn();
  const fetchMock = vi.fn(async () => new Response(html, { headers: { "content-type": "text/html" } }));
  const ctx: AdapterContext = {
    sink,
    logger: { log },
    fetch: fetchMock as unknown as typeof fetch,
    skipRobotsCheck: true,
    summarize,
  };
  return { ctx, sink, log, fetchMock };
}

const meta = { provider: "html_minutes", url: "https://minutes.example.gov/2026-03" } as const;

describe("ingestHtmlMinutes", () => {
  it("skips with a warning when no LLM callback is provided", async () => {
    const { ctx, log, fetchMock } = setup(undefined);
    expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toEqual({ inserted: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("requires ctx.summarize"), "warn");
  });

  it("strips scripts/tags before handing text to the model", async () => {
    const summarize = vi.fn(async () => "[]");
    const { ctx } = setup(summarize);
    await ingestHtmlMinutes(locality, source, meta, ctx);
    expect(summarize).toHaveBeenCalledWith(expect.any(String), "Minutes Motion to approve budget passed.");
  });

  it("ingests validated items, sanitizes dates, and drops malformed ones", async () => {
    const future = new Date(Date.now() + 800 * 86_400_000).toISOString().slice(0, 10);
    const summarize = vi.fn(async () =>
      "```json\n" +
        JSON.stringify([
          { title: "Approve budget", action: "Voted", result: "Approved 5-2", date: "2026-03-04" },
          { title: "Bogus future date", date: future },
          { action: "no title" },
          { title: 42 },
        ]) +
        "\n```"
    );
    const { ctx, sink, log } = setup(summarize);
    const result = await ingestHtmlMinutes(locality, source, meta, ctx);

    expect(result).toEqual({ inserted: 2, skipped: 0 });
    const recs = [...sink.records.values()];
    expect(recs[0]).toMatchObject({
      provider: "html_minutes",
      type: "council_meeting",
      title: "Approve budget",
      summary: "Voted — Approved 5-2",
      date: "2026-03-04",
      url: meta.url,
    });
    expect(recs[1]?.date).toBeNull(); // far-future date rejected, as in every other adapter
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dropped 2 malformed"), "warn");
  });

  it("is idempotent across runs", async () => {
    const summarize = vi.fn(async () => JSON.stringify([{ title: "Approve budget" }]));
    const { ctx } = setup(summarize);
    expect((await ingestHtmlMinutes(locality, source, meta, ctx)).inserted).toBe(1);
    expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toEqual({ inserted: 0, skipped: 1 });
  });

  it("returns zeros when the model replies with prose instead of JSON", async () => {
    const { ctx, log, sink } = setup(async () => "There were no actionable items.");
    expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toEqual({ inserted: 0, skipped: 0 });
    expect(sink.records.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("parse failed"), "warn");
  });

  it("survives the summarize callback throwing", async () => {
    const { ctx, log } = setup(async () => {
      throw new Error("rate limited");
    });
    expect(await ingestHtmlMinutes(locality, source, meta, ctx)).toEqual({ inserted: 0, skipped: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("rate limited"), "warn");
  });

  it("warns when there is no url", async () => {
    const { ctx, log } = setup(async () => "[]");
    await ingestHtmlMinutes(locality, source, { provider: "html_minutes" }, ctx);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no URL"), "warn");
  });
});
