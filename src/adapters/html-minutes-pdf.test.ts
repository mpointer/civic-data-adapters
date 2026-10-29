import { describe, it, expect, vi } from "vitest";
import type { AdapterContext } from "../types.js";
import { MemorySink } from "../types.js";

// readPdfText reports the PDF's own page count, so a cut is known, not guessed.
vi.mock("./legistar.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./legistar.js")>();
  return {
    ...original,
    readPdfText: vi.fn(async (url: string) => {
      if (url.includes("pages")) return { text: "Approve the budget and adjourn the meeting after discussion, as noted in the agenda packet pages that were attached to the meeting notice", numpages: 90, pagesRead: 40, textTruncated: false };
      if (url.includes("chars")) return { text: "Approve the budget. ".repeat(3_400), numpages: 20, pagesRead: 20, textTruncated: true };
      return { text: "Approve the budget and adjourn the meeting after discussion, as noted in the attached short agenda text that was posted before the meeting", numpages: 2, pagesRead: 2, textTruncated: false };
    }),
  };
});

const { ingestHtmlMinutes } = await import("./html-minutes.js");

const run = async (url: string) => {
  const ctx: AdapterContext = {
    sink: new MemorySink(),
    logger: { log: vi.fn() },
    skipRobotsCheck: true,
    summarize: async () => JSON.stringify([{ title: "Approve the budget" }]),
    fetch: (async () => new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch,
  };
  return ingestHtmlMinutes({ name: "Town" }, { id: 1 }, { provider: "html_minutes", url }, ctx);
};

describe("html_minutes with PDF minutes", () => {
  it("is partial when the PDF has more pages than were read", async () => {
    const r = await run("https://x.example.gov/pages.pdf");
    expect(r.status).toBe("partial");
    expect(r.problems.join()).toMatch(/PDF has 90 pages; only the first 40 were read/);
  });

  it("is partial when the extracted text hit the character cap", async () => {
    const r = await run("https://x.example.gov/chars.pdf");
    expect(r.status).toBe("partial");
    expect(r.problems.join()).toMatch(/truncated at 64000 chars/);
  });

  it("is ok for a short document", async () => {
    expect(await run("https://x.example.gov/short.pdf")).toMatchObject({ status: "ok", problems: [] });
  });
});
