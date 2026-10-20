// Capture a real police-blotter page as a test fixture.
//
//   npm run build
//   node scripts/capture-fixtures.mjs html       <name> <url>
//   node scripts/capture-fixtures.mjs pdf        <name> <url>
//   node scripts/capture-fixtures.mjs crimewatch <name> <url>
//
// Writes fixtures/blotter/<name>/ (see scripts/fixture-format.mjs). Respects
// robots.txt. Flags: --force (overwrite), --allow-empty (keep a capture that
// parses to zero rows; useful as a "this layout broke us" regression).
//
// READ BEFORE COMMITTING: blotters contain real people's names, addresses and
// arrests, and this repo is public. The capture is saved with
// "reviewedForPii": false, and the fixture test FAILS until you open the files,
// redact what should not be republished, and flip that flag to true.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedByRobots, parseBlotterHtml, extractIncidents, fetchCrimewatchIncidents } from "../dist/index.js";
import { PAYLOAD_FILE, recordingFetch } from "./fixture-format.mjs";

const UA = "civic-data-adapters fixture-capture (+https://github.com/mpointer/civic-data-adapters)";
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const [kind, name, url] = args;

if (!PAYLOAD_FILE[kind] || !name || !url || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
  console.error("usage: node scripts/capture-fixtures.mjs <html|pdf|crimewatch> <name> <url> [--force] [--allow-empty]");
  process.exit(2);
}
const dir = join(here, "..", "fixtures", "blotter", name);
if (existsSync(dir) && !flags.has("--force")) {
  console.error(`${dir} already exists (use --force to overwrite)`);
  process.exit(2);
}

try {
  const get = async (type) => {
    if (!(await isAllowedByRobots(url, { userAgent: UA }))) throw new Error("robots.txt disallows this URL");
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return type === "text" ? res.text() : Buffer.from(await res.arrayBuffer());
  };

  let payload;
  let rows;
  if (kind === "html") {
    payload = await get("text");
    rows = parseBlotterHtml(payload).length;
  } else if (kind === "pdf") {
    payload = await get("buffer");
    const pdfParse = createRequire(import.meta.url)("pdf-parse");
    rows = extractIncidents((await pdfParse(payload, { max: 20 })).text).length;
    if (payload.length > 1_000_000) console.warn(`warning: PDF is ${(payload.length / 1e6).toFixed(1)} MB; consider a 1-2 page excerpt`);
  } else {
    const log = [];
    const incidents = await fetchCrimewatchIncidents(url, { fetch: recordingFetch(fetch, log), userAgent: UA });
    payload = JSON.stringify(log, null, 2);
    rows = incidents.length;
  }

  if (rows === 0 && !flags.has("--allow-empty")) {
    console.error("parsed 0 rows, so nothing was saved (use --allow-empty to keep it as a regression fixture)");
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PAYLOAD_FILE[kind]), payload);
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ kind, url, capturedAt: new Date().toISOString(), reviewedForPii: false, notes: "" }, null, 2) + "\n",
  );
  console.log(`saved ${dir}\nparsed ${rows} row(s)\n`);
  console.log("Next: open the files, redact names/addresses that should not be republished,");
  console.log('set "reviewedForPii": true in meta.json, then run `npx vitest run src/fixtures.test.ts -u`');
  console.log("to write the expected-output snapshot, and read it before you commit.");
} catch (err) {
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
  console.error(`capture failed: ${err instanceof Error ? err.message : err}${cause}`);
  process.exit(1);
}
