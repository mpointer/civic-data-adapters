// Council meeting minutes/agenda parser for plain HTML or PDF pages. Free-form
// minutes have no reliable structure, so this adapter REQUIRES ctx.summarize
// (an LLM callback) to extract structured action items; without it the
// adapter logs a warning and skips.
import { createHash } from "node:crypto";
import { sanitizeCivicDate } from "../dates.js";
import { parseMinutesItems } from "../validate.js";
import type {
  Locality,
  CivicSource,
  MetaFor,
  AdapterContext,
  AdapterResult,
  CivicRecord,
} from "../types.js";
import { ctxFetch, ctxUserAgent, robotsAllows } from "../internal.js";
import { createRun } from "../outcome.js";
import { extractPdfText } from "./legistar.js";

/**
 * Dedupe key for one extracted minutes/agenda item: the source, the document it
 * came from, and the FULL title (trimmed, case-insensitive), hashed.
 *
 * Before 0.4 the key was `htmlminutes:<sourceId>:<first 12 chars of base64(title)>` —
 * that is the first 9 characters of the title, so "Resolution 2026-62 …" and
 * "Resolution 2026-63 …" collided (a real agenda of 9 items kept 3), and it ignored
 * the document, so a recurring item ("Public comment") was dropped from every
 * meeting after the first. Including the document URL keeps recurring items
 * distinct per meeting while re-running the same document stays a no-op.
 */
export function minutesDedupeKey(sourceId: string | number | undefined, documentUrl: string, title: string): string {
  const hash = createHash("sha1").update(`${documentUrl}\n${title.trim().toLowerCase()}`).digest("hex").slice(0, 16);
  return `htmlminutes:${sourceId}:${hash}`;
}

/**
 * The pre-0.4 key. Exported ONLY so a consumer upgrading from 0.3 can find rows stored
 * under the old scheme and rewrite them to `minutesDedupeKey` (otherwise the first run
 * after upgrading re-inserts items it already has). Do not use for new code.
 * @deprecated
 */
export function legacyMinutesDedupeKey(sourceId: string | number | undefined, title: string): string {
  return `htmlminutes:${sourceId}:${Buffer.from(title).toString("base64").slice(0, 12)}`;
}

const PARSE_SYSTEM = `You extract structured action items from city council meeting minutes or agendas.
Return ONLY a JSON array. Each item: {
  "title": string,
  "action": string|null,
  "result": string|null,
  "date": string|null
}
title = the motion or agenda item description (1 sentence max).
action = what was voted on or discussed.
result = the outcome (e.g. "Approved 5-2", "Tabled", "Passed unanimously") or null if unknown.
date = ISO date (YYYY-MM-DD) if stated, else null.
Return [] if no actionable items are found. Never invent details.`;

// What the model is given, and how many items we keep. Both silently dropped
// the rest before; they still do, but now say so.
const MAX_SOURCE_CHARS = 8_000;
const MAX_ITEMS = 50;

interface FetchedText {
  text: string;
  isPdf: boolean;
  /** Text was cut to MAX_SOURCE_CHARS. For PDFs this is "reached the cap". */
  truncated: boolean;
  /** Length before truncation, when known (HTML only). */
  originalChars?: number;
}

async function fetchText(
  url: string,
  ctx: AdapterContext
): Promise<FetchedText | null> {
  if (!(await robotsAllows(url, ctx))) return null;
  try {
    const res = await ctxFetch(ctx)(url, {
      headers: { "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    const isPdf = ct.includes("pdf") || url.toLowerCase().endsWith(".pdf");
    if (isPdf) {
      const text = await extractPdfText(url, ctx);
      return text ? { text, isPdf: true, truncated: text.length >= MAX_SOURCE_CHARS } : null;
    }
    const html = await res.text();
    const full = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      text: full.slice(0, MAX_SOURCE_CHARS),
      isPdf: false,
      truncated: full.length > MAX_SOURCE_CHARS,
      originalChars: full.length,
    };
  } catch {
    return null;
  }
}

export async function ingestHtmlMinutes(
  locality: Locality,
  source: CivicSource,
  meta: MetaFor<"html_minutes">,
  ctx: AdapterContext
): Promise<AdapterResult> {
  const run = createRun(ctx, `[${locality.name}] html_minutes:`);
  if (!ctx.summarize) return run.fail("requires ctx.summarize (an LLM callback) — skipping");

  const url = meta.url ?? source.url;
  if (!url) return run.fail(`source ${source.id}: no URL`);

  const fetched = await fetchText(url, ctx);
  if (!fetched) return run.fail(`${url}: fetch failed`);

  // Image-only PDF detection
  if (fetched.isPdf && fetched.text.replace(/\s+/g, "").length < 100) {
    return run.fail(`${url}: image-only PDF — no text layer, skipping`);
  }

  if (fetched.truncated) {
    await run.problem(
      fetched.isPdf
        ? `${url}: document text may be truncated at ${MAX_SOURCE_CHARS} chars; items past the cut are not extracted`
        : `${url}: page text truncated from ${fetched.originalChars} to ${MAX_SOURCE_CHARS} chars; items past the cut are not extracted`
    );
  }

  let raw: string;
  try {
    raw = await ctx.summarize(PARSE_SYSTEM, fetched.text);
  } catch (err) {
    return run.fail(`${url}: summarize failed — ${err}`);
  }
  const parsed = parseMinutesItems(raw);
  if (!parsed.ok) return run.fail(`${url}: parse failed — ${parsed.error}`);
  if (parsed.value.dropped > 0) {
    await run.problem(`${url}: dropped ${parsed.value.dropped} malformed item(s)`);
  }

  const records: CivicRecord[] = [];
  if (parsed.value.items.length > MAX_ITEMS) {
    await run.problem(`${url}: kept ${MAX_ITEMS} of ${parsed.value.items.length} items`);
  }
  for (const item of parsed.value.items.slice(0, MAX_ITEMS)) {
    const key = minutesDedupeKey(source.id, url, item.title);
    records.push({
      provider: "html_minutes",
      type: "council_meeting",
      title: item.title,
      summary: [item.action, item.result].filter(Boolean).join(" — ") || null,
      date: sanitizeCivicDate(item.date),
      url,
      dedupeKey: key,
      localityName: locality.name,
      sourceId: source.id,
    });
  }

  return run.done(await ctx.sink.save(records), records.length);
}
