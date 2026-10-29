import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parsePdf, resolveParser, PdfParserMissingError } from "./pdf.js";
import { extractIncidents } from "./adapters/blotter-pdf.js";

const require = createRequire(import.meta.url);
const fixture = new Uint8Array(readFileSync(new URL("./test-data/three-pages.pdf", import.meta.url)));
const V1 = require.resolve("pdf-parse");
const V2 = require.resolve("pdf-parse-v2");

function fakeParser(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "fake-parser-")), "index.cjs");
  writeFileSync(file, body);
  return file;
}

describe.each([
  ["pdf-parse 1.x", V1],
  ["pdf-parse 2.x", V2],
])("parsePdf with %s", (_name, parser) => {
  it("extracts text and reports the page count", async () => {
    const r = await parsePdf(fixture, { maxPages: 10 }, parser);
    expect(r.numpages).toBe(3);
    expect(r.text).toContain("Exampleville Police Department");
    expect(r.text).toContain("03/07/2026 Burglary");
  });

  it("reads only maxPages pages but still reports the true total", async () => {
    const r = await parsePdf(fixture, { maxPages: 1 }, parser);
    expect(r.numpages).toBe(3);
    expect(r.text).toContain("Theft");
    expect(r.text).not.toContain("Vandalism");
    expect(r.text).not.toContain("Burglary");
  });

  it("yields text the incident extractor can read", async () => {
    const { text } = await parsePdf(fixture, { maxPages: 10 }, parser);
    const incidents = extractIncidents(text);
    expect(incidents.map((i) => i.date)).toEqual(["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07"]);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(parsePdf(new TextEncoder().encode("not a pdf at all"), { maxPages: 10 }, parser)).rejects.toThrow();
  });
});

describe("parsePdf isolation", () => {
  it("kills a parser that never returns, and the process carries on", async () => {
    const hang = fakeParser("module.exports = () => { for (;;) {} };");
    const started = Date.now();
    await expect(parsePdf(fixture, { maxPages: 1, timeoutMs: 400 }, hang)).rejects.toThrow(/timed out after 400 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // the parent event loop was never blocked: this runs
    expect(await parsePdf(fixture, { maxPages: 1 }, V1)).toMatchObject({ numpages: 3 });
  });

  it("kills a parser that eats memory", async () => {
    const hog = fakeParser("module.exports = () => { const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random())); };");
    await expect(parsePdf(fixture, { maxPages: 1, memoryMb: 64, timeoutMs: 20_000 }, hog)).rejects.toThrow(/memory/i);
  }, 30_000);

  it("reports a parser that exits without answering", async () => {
    const quiet = fakeParser("module.exports = () => new Promise(() => {});");
    await expect(parsePdf(fixture, { maxPages: 1, timeoutMs: 5_000 }, quiet)).rejects.toThrow(/without a result/);
  });

  it("rejects a parser module with an API it does not know", async () => {
    const odd = fakeParser("module.exports = { somethingElse: 1 };");
    await expect(parsePdf(fixture, { maxPages: 1 }, odd)).rejects.toThrow(/unsupported pdf-parse API/);
  });

  it("does not let the parser write to the host's stdout", async () => {
    const noisy = fakeParser('module.exports = async () => { console.log("NOISE-FROM-PARSER"); process.stdout.write("MORE-NOISE\\n"); return { text: "x", numpages: 1 }; };');
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      writes.push(String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      await parsePdf(fixture, { maxPages: 1 }, noisy);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.stdout.write = original;
    }
    expect(writes.join("")).not.toContain("NOISE");
  });
});

describe("resolveParser", () => {
  it("finds the installed parser", () => {
    expect(resolveParser()).toBe(V1);
  });

  it("says what to install when the parser is missing", () => {
    expect(() => resolveParser("definitely-not-installed-pdf-parser")).toThrow(PdfParserMissingError);
    expect(() => resolveParser("definitely-not-installed-pdf-parser")).toThrow(/npm install pdf-parse/);
  });
});
