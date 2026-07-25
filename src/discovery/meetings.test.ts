import { describe, it, expect, vi } from "vitest";
import { discoverMeetingPortal } from "./meetings.js";
import type { DiscoveryContext, Locality } from "../types.js";

const locality: Locality = { name: "Exampleville, PA", state: "PA" };

// verifyLegistarClient hits https://webapi.legistar.com/v1/{clientId}/Bodies?$top=1
function makeCtx(clientIds: string[], validId: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `https://webapi.legistar.com/v1/${validId}/Bodies?$top=1`) {
      return { ok: true, json: async () => [{ BodyId: 1 }] } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  const log = vi.fn();
  const ctx: DiscoveryContext = {
    generate: vi.fn(async () => JSON.stringify(clientIds.map((clientId) => ({ clientId })))),
    fetch: fetchMock as unknown as typeof fetch,
    logger: { log },
    skipRobotsCheck: true,
  };
  return { ctx, fetchMock, log };
}

describe("discoverMeetingPortal propose→verify", () => {
  it("skips a clientId the Legistar API rejects and returns the one that answers", async () => {
    const { ctx, fetchMock } = makeCtx(["bogusville", "Exampleville"], "exampleville");

    const sources = await discoverMeetingPortal(locality, ctx);

    expect(sources).toHaveLength(1);
    const src = sources[0]!;
    expect(src.provider).toBe("legistar");
    // Candidate was lowercased before verification.
    expect(src.meta).toEqual({ provider: "legistar", clientId: "exampleville" });
    expect(src.url).toBe("https://exampleville.legistar.com");
    expect(src.evidence).toContain("Legistar API answered");
    expect(src.evidence).toContain("exampleville");

    const fetched = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetched).toEqual([
      "https://webapi.legistar.com/v1/bogusville/Bodies?$top=1",
      "https://webapi.legistar.com/v1/exampleville/Bodies?$top=1",
    ]);
  });

  it("returns [] when no candidate verifies", async () => {
    const { ctx, log } = makeCtx(["bogusville"], "never-valid");
    expect(await discoverMeetingPortal(locality, ctx)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("candidate(s) verified"), "warn");
  });

  it("returns [] when the LLM reply is garbage", async () => {
    const { ctx, fetchMock } = makeCtx([], "unused");
    ctx.generate = vi.fn(async () => "This town does not use Legistar.");
    expect(await discoverMeetingPortal(locality, ctx)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
