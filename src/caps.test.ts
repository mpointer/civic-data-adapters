// Response bodies are capped: a hostile or broken endpoint must not be able to
// make an adapter buffer gigabytes.
import { describe, it, expect, vi } from "vitest";
import { runAdapter } from "./registry.js";
import { MemorySink } from "./types.js";
import type { AdapterContext, Locality } from "./types.js";

const locality: Locality = { name: "Exampleville", state: "PA" };
const MiB = 1024 * 1024;

/** A body of `chunks` x 1 MiB that counts how many chunks were actually pulled. */
function bigBody(chunks: number, contentType: string, headers: Record<string, string> = {}) {
  let pulled = 0;
  const chunk = new Uint8Array(MiB).fill(32);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (pulled >= chunks) return c.close();
        pulled++;
        c.enqueue(chunk);
      },
    },
    { highWaterMark: 0 }
  );
  return { res: new Response(stream, { headers: { "content-type": contentType, ...headers } }), pulled: () => pulled };
}

function ctxFor(res: Response): AdapterContext {
  return { sink: new MemorySink(), logger: { log: vi.fn() }, skipRobotsCheck: true, fetch: (async () => res) as unknown as typeof fetch };
}

describe("response size caps", () => {
  it("blotter_html fails on a page over 5 MiB, having read only a little more than the cap", async () => {
    const { res, pulled } = bigBody(200, "text/html");
    const r = await runAdapter(locality, { id: 1 }, { provider: "blotter_html", url: "https://pd.example.gov/b" }, ctxFor(res));
    expect(r.status).toBe("failed");
    expect(r.problems.join()).toContain("exceeds 5242880 bytes");
    expect(pulled()).toBeLessThanOrEqual(7);
  });

  it("socrata fails on a JSON body over 25 MiB without buffering it all", async () => {
    const { res, pulled } = bigBody(500, "application/json");
    const r = await runAdapter(locality, { id: 1 }, { provider: "socrata", url: "https://data.example.gov", resourceId: "abcd-1234" }, ctxFor(res));
    expect(r.status).toBe("failed");
    expect(r.problems.join()).toContain("exceeds");
    expect(pulled()).toBeLessThanOrEqual(27);
  });

  it("an honest Content-Length over the cap is refused before any byte is read", async () => {
    const { res, pulled } = bigBody(200, "text/html", { "content-length": String(500 * MiB) });
    const r = await runAdapter(locality, { id: 1 }, { provider: "blotter_html", url: "https://pd.example.gov/b" }, ctxFor(res));
    expect(r.status).toBe("failed");
    expect(pulled()).toBe(0);
  });

  it("blotter_pdf fails on a PDF over 25 MiB", async () => {
    const { res, pulled } = bigBody(500, "application/pdf");
    const r = await runAdapter(locality, { id: 1 }, { provider: "blotter_pdf", url: "https://pd.example.gov/b.pdf" }, ctxFor(res));
    expect(r.status).toBe("failed");
    expect(pulled()).toBeLessThanOrEqual(27);
  });

  it("html_minutes fails on an oversized page", async () => {
    const { res } = bigBody(200, "text/html");
    const ctx = { ...ctxFor(res), summarize: async () => "[]" };
    const r = await runAdapter(locality, { id: 1 }, { provider: "html_minutes", url: "https://minutes.example.gov/m" }, ctx);
    expect(r.status).toBe("failed");
    expect(r.problems.join()).toContain("exceeds");
  });
});
