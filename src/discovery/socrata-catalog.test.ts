import { describe, it, expect, vi } from "vitest";
import { searchSocrataCatalog } from "./socrata-catalog.js";
import type { Locality, DiscoveryContext } from "../types.js";

const locality: Locality = { name: "Exampleville, PA", state: "PA" };

function catalogResult(overrides: {
  id: string;
  name: string;
  categories?: string[];
  columns?: string[];
}) {
  return {
    resource: {
      id: overrides.id,
      name: overrides.name,
      description: null,
      type: "dataset",
      columns_name: overrides.columns ?? [],
      columns_field_name: overrides.columns ?? [],
      columns_datatype: (overrides.columns ?? []).map(() => "text"),
      updatedAt: null,
    },
    link: `https://data.exampleville.gov/d/${overrides.id}`,
    metadata: { domain: "data.exampleville.gov" },
    classification: { categories: overrides.categories ?? [], tags: [] },
  };
}

function makeCtx(results: unknown[]) {
  const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.us.socrata.com/api/catalog/v1")) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return {
      ok: true,
      json: async () => ({ results, resultSetSize: results.length }),
    } as unknown as Response;
  });
  const log = vi.fn();
  // No `generate` — the catalog search is LLM-free.
  const ctx = { fetch: fetchMock as unknown as typeof fetch, logger: { log } };
  return { ctx, fetchMock, log };
}

describe("searchSocrataCatalog", () => {
  it("returns column-mapped proposals for civic datasets and skips irrelevant ones", async () => {
    const { ctx, fetchMock } = makeCtx([
      catalogResult({
        id: "abcd-1234",
        name: "Police Incident Blotter",
        categories: ["Public Safety"],
        columns: ["incident_date", "case_number", "offense_type", "description", "address"],
      }),
      catalogResult({ id: "tree-0001", name: "Street Tree Inventory", categories: ["Environment"] }),
    ]);

    const sources = await searchSocrataCatalog(locality, "https://data.exampleville.gov", ctx);

    expect(sources).toHaveLength(1);
    const src = sources[0]!;
    expect(src.provider).toBe("socrata");
    expect(src.name).toBe("Police Incident Blotter");
    expect(src.url).toBe("https://data.exampleville.gov/resource/abcd-1234.json");
    expect(src.meta).toMatchObject({
      provider: "socrata",
      url: "https://data.exampleville.gov",
      resourceId: "abcd-1234",
      recordType: "police_blotter",
      dateField: "incident_date",
      caseField: "case_number",
    });
    if (src.meta.provider !== "socrata") throw new Error("expected a socrata source");
    expect(src.meta.titleFields).toContain("offense_type");
    expect(src.evidence).toContain("abcd-1234");
    expect(src.evidence).toContain("police_blotter");

    // Queried the catalog scoped to the portal domain, single page.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("domains=data.exampleville.gov");
    expect(calledUrl).toContain("only=datasets");
  });

  it("dedupes repeated datasets within one run", async () => {
    const dup = catalogResult({
      id: "abcd-1234",
      name: "Police Incident Blotter",
      categories: ["Public Safety"],
      columns: ["incident_date"],
    });
    const { ctx } = makeCtx([dup, dup]);
    const sources = await searchSocrataCatalog(locality, "data.exampleville.gov", ctx);
    expect(sources).toHaveLength(1);
  });

  it("returns [] and warns when the catalog API errors", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    const log = vi.fn();
    const ctx = { fetch: fetchMock as unknown as typeof fetch, logger: { log } };
    expect(await searchSocrataCatalog(locality, "data.exampleville.gov", ctx)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"), "warn");
  });
});

describe("searchSocrataCatalog malformed catalog responses", () => {
  const dataset = (over: Record<string, unknown> = {}) => ({
    resource: {
      id: "abcd-1234",
      name: "Police Incident Reports",
      description: "crime incidents",
      type: "dataset",
      columns_name: ["Date"],
      columns_field_name: ["date", "offense_type"],
      columns_datatype: ["text", "text"],
      updatedAt: null,
    },
    link: "https://data.example.gov/d/abcd-1234",
    metadata: { domain: "data.example.gov" },
    classification: { categories: ["Public Safety"], tags: ["police"] },
    ...over,
  });
  const run = async (body: unknown) => {
    const log = vi.fn();
    const ctx: DiscoveryContext = {
      generate: vi.fn(),
      logger: { log },
      fetch: (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch,
    };
    return { out: await searchSocrataCatalog({ name: "Exampleville, PA" }, "data.example.gov", ctx), log };
  };

  it("stops with a warning when results isn't an array", async () => {
    const { out, log } = await run({ error: "boom" });
    expect(out).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("unexpected response shape"), "warn");
  });

  it("skips malformed entries and still proposes the good one; tolerates missing classification", async () => {
    const { out } = await run({
      resultSetSize: 3,
      results: [null, { resource: null }, dataset({ classification: undefined })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.meta).toMatchObject({ provider: "socrata", resourceId: "abcd-1234", recordType: "police_blotter" });
  });
});
