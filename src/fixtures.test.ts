import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBlotterHtml, extractIncidents, fetchCrimewatchIncidents } from "./index.js";
// Plain .mjs shared with scripts/capture-fixtures.mjs: one definition of the format.
// @ts-expect-error no type declarations for the script module
import { discoverFixtures, recordingFetch, replayFetch, PAYLOAD_FILE } from "../scripts/fixture-format.mjs";

// Replays captured real pages through the real parsers. Capture with
// scripts/capture-fixtures.mjs; see fixtures/README.md. A fixture's expected
// output is a file snapshot (`vitest -u` writes it), so a parser change that
// alters what a real page yields shows up as a reviewable diff.

const ROOT = fileURLToPath(new URL("../fixtures/blotter/", import.meta.url));
const require = createRequire(import.meta.url);

interface Fixture {
  name: string;
  dir: string;
  payloadPath: string;
  meta: { kind: "html" | "pdf" | "crimewatch"; url: string; reviewedForPii?: boolean; allowEmpty?: boolean };
}

async function parseFixture(f: Fixture): Promise<unknown[]> {
  if (f.meta.kind === "html") return parseBlotterHtml(readFileSync(f.payloadPath, "utf8"));
  if (f.meta.kind === "pdf") {
    const pdfParse = require("pdf-parse") as (b: Buffer, o?: { max?: number }) => Promise<{ text: string }>;
    return extractIncidents((await pdfParse(readFileSync(f.payloadPath), { max: 20 })).text);
  }
  const exchanges = JSON.parse(readFileSync(f.payloadPath, "utf8"));
  return fetchCrimewatchIncidents(f.meta.url, { fetch: replayFetch(exchanges) as typeof fetch, skipRobotsCheck: true });
}

const fixtures = discoverFixtures(ROOT) as Fixture[];

describe("recorded blotter fixtures", () => {
  if (fixtures.length === 0) {
    it.skip("none captured yet (see fixtures/README.md)", () => {});
  }
  for (const f of fixtures) {
    describe(f.name, () => {
      it("has been reviewed for personal information", () => {
        expect(
          f.meta.reviewedForPii,
          `${f.name}: open the files, redact names/addresses that should not be republished, then set "reviewedForPii": true in meta.json`,
        ).toBe(true);
      });

      it("parses to the expected incidents", async () => {
        const rows = await parseFixture(f);
        if (!f.meta.allowEmpty) expect(rows.length, "parsed zero rows: has the page layout changed?").toBeGreaterThan(0);
        await expect(JSON.stringify(rows, null, 2) + "\n").toMatchFileSnapshot(`../fixtures/blotter/__expected__/${f.name}.json`);
      });
    });
  }
});

// The harness itself, exercised on synthetic data in a temp dir (never committed
// as if it were a real capture).
describe("fixture harness", () => {
  const SETTINGS = { cw_web: { api_key: "k", site_path: "https://crimewatch.net", base_path: "/", feed: { data: { gid: "1" } } } };
  const origin = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("services/session/token")) return new Response("tok");
    if (url.includes("api/cw_web/feed")) {
      const { bundle, page } = JSON.parse(String(init?.body));
      const results = bundle === "incident" && page === 0 ? [{ nid: 7, title: "Theft", body: "b" }] : [];
      return new Response(JSON.stringify({ results, page, pages: 1, count: results.length }));
    }
    return new Response(`<script>jQuery.extend(Drupal.settings, ${JSON.stringify(SETTINGS)});</script>`);
  };
  const URL1 = "https://crimewatch.net/us/pa/x/town-pd/incidents";

  it("records a CrimeWatch flow, saves it, rediscovers it, and replays it to the same incidents", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "fixtures-"));
    try {
      const log: unknown[] = [];
      const live = await fetchCrimewatchIncidents(URL1, { fetch: recordingFetch(origin, log) as typeof fetch, skipRobotsCheck: true });
      expect(live).toHaveLength(1);

      const dir = join(tmp, "town-pd");
      mkdirSync(dir);
      writeFileSync(join(dir, PAYLOAD_FILE.crimewatch), JSON.stringify(log));
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ kind: "crimewatch", url: URL1 }));

      const [found, ...rest] = discoverFixtures(tmp) as Fixture[];
      expect(rest).toHaveLength(0);
      expect(found?.meta.kind).toBe("crimewatch");
      expect(await parseFixture(found!)).toEqual(live);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("replay refuses requests that were never recorded", async () => {
    await expect(replayFetch([])("https://example.org/x")).rejects.toThrow(/no recorded exchange/);
  });

  it("discovery ignores folders without meta.json and tolerates a missing root", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fixtures-"));
    try {
      mkdirSync(join(tmp, "stray"));
      expect(discoverFixtures(tmp)).toEqual([]);
      expect(discoverFixtures(join(tmp, "does-not-exist"))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
