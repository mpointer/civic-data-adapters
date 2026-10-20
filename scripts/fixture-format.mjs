// Shared by scripts/capture-fixtures.mjs and src/fixtures.test.ts so the
// on-disk fixture format has exactly one definition.
//
// Layout: fixtures/blotter/<name>/
//   meta.json        { kind, url, capturedAt, reviewedForPii, notes? }
//   page.html        kind "html"        the blotter page, as served
//   document.pdf     kind "pdf"         the blotter PDF, as served
//   exchanges.json   kind "crimewatch"  every HTTP exchange the feed flow made
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PAYLOAD_FILE = {
  html: "page.html",
  pdf: "document.pdf",
  crimewatch: "exchanges.json",
};

const requestKey = (method, url, body) => `${method.toUpperCase()} ${url} ${body ?? ""}`;
const bodyOf = (init) => (typeof init?.body === "string" ? init.body : null);

/** Wrap a real fetch, appending each exchange (request + response text) to `log`. */
export function recordingFetch(realFetch, log) {
  return async (input, init) => {
    const res = await realFetch(input, init);
    log.push({
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      body: bodyOf(init),
      status: res.status,
      text: await res.clone().text(),
    });
    return res;
  };
}

/** A fetch that answers only from recorded exchanges; anything else throws, so
 *  a parser change that makes a new request fails loudly instead of hanging. */
export function replayFetch(exchanges) {
  const byKey = new Map(exchanges.map((e) => [requestKey(e.method, e.url, e.body), e]));
  return async (input, init) => {
    const key = requestKey(init?.method ?? "GET", String(input), bodyOf(init));
    const hit = byKey.get(key);
    if (!hit) throw new Error(`no recorded exchange for: ${key}`);
    return new Response(hit.text, { status: hit.status });
  };
}

/** Every <root>/<name>/meta.json, as { name, dir, meta, payloadPath }. Missing root => []. */
export function discoverFixtures(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => ({ name, dir: join(root, name) }))
    .filter((f) => statSync(f.dir).isDirectory() && existsSync(join(f.dir, "meta.json")))
    .map((f) => {
      const meta = JSON.parse(readFileSync(join(f.dir, "meta.json"), "utf8"));
      return { ...f, meta, payloadPath: join(f.dir, PAYLOAD_FILE[meta.kind] ?? "") };
    });
}
