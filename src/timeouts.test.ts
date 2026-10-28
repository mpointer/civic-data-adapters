import { describe, it, expect } from "vitest";
import { runAdapter, MemorySink, searchSocrataCatalog } from "./index.js";
import { FETCH_TIMEOUT_MS } from "./internal.js";

// Every outbound request needs its own deadline. Node's fetch default is about
// 300 s per request, which is the whole budget of a serverless invocation, so a
// single hung server could eat a scheduled run. Each case below drives one
// adapter and checks that its first network request carries an abort signal.

function recorder(body: string) {
  const inits: Array<RequestInit | undefined> = [];
  const fetchMock = (async (_input: unknown, init?: RequestInit) => {
    inits.push(init);
    return new Response(body);
  }) as unknown as typeof fetch;
  return { inits, fetchMock };
}

const locality = { name: "Town" };

describe("outbound requests have a deadline", () => {
  it("has a sane default deadline", () => {
    expect(FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(FETCH_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("legistar Events", async () => {
    const { inits, fetchMock } = recorder("[]");
    await runAdapter(locality, { id: 1 }, { provider: "legistar", clientId: "x" }, { sink: new MemorySink(), fetch: fetchMock, skipRobotsCheck: true });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("blotter_html page", async () => {
    const { inits, fetchMock } = recorder("<p>no tables</p>");
    await runAdapter(locality, { id: 1 }, { provider: "blotter_html", url: "https://pd.example.gov/b" }, { sink: new MemorySink(), fetch: fetchMock, skipRobotsCheck: true });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("blotter_pdf document", async () => {
    const { inits, fetchMock } = recorder("not a pdf");
    await runAdapter(locality, { id: 1 }, { provider: "blotter_pdf", url: "https://pd.example.gov/b.pdf" }, { sink: new MemorySink(), fetch: fetchMock, skipRobotsCheck: true });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("socrata records", async () => {
    const { inits, fetchMock } = recorder("[]");
    await runAdapter(locality, { id: 1 }, { provider: "socrata", url: "https://data.example.gov", resourceId: "abcd-1234" }, { sink: new MemorySink(), fetch: fetchMock });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("socrata catalog search", async () => {
    const { inits, fetchMock } = recorder('{"results":[],"resultSetSize":0}');
    await searchSocrataCatalog(locality, "data.example.gov", { fetch: fetchMock });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
