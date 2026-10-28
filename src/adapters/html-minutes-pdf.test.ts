import { describe, it, expect, vi } from "vitest";
import type { AdapterContext } from "../types.js";
import { MemorySink } from "../types.js";

// extractPdfText caps its output at 8000 chars and cannot say whether it cut
// anything, so a result at the cap is reported as possibly truncated.
vi.mock("./legistar.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./legistar.js")>();
  return { ...original, extractPdfText: vi.fn(async (url: string) => (url.includes("long") ? "x".repeat(8_000) : "short agenda text")) };
});

const { ingestHtmlMinutes } = await import("./html-minutes.js");

const run = async (url: string) => {
  const log = vi.fn();
  const ctx: AdapterContext = {
    sink: new MemorySink(),
    logger: { log },
    skipRobotsCheck: true,
    summarize: async () => "[]",
    fetch: (async () => new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch,
  };
  await ingestHtmlMinutes({ name: "Town" }, { id: 1 }, { provider: "html_minutes", url }, ctx);
  return log;
};

describe("html_minutes with PDF minutes", () => {
  it("warns when the extracted text reached the cap", async () => {
    const log = await run("https://x.example.gov/long.pdf");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/may be truncated at 8000 chars/), "warn");
  });

  it("stays quiet for a short document", async () => {
    const log = await run("https://x.example.gov/short.pdf");
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/truncated/), "warn");
  });
});
