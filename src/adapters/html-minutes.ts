// Council meeting minutes/agenda parser for plain HTML or PDF pages. Free-form
// minutes have no reliable structure, so this adapter REQUIRES ctx.summarize
// (an LLM callback) to extract structured action items; without it the
// adapter logs a warning and skips.
import { createHash } from "node:crypto";
import { sanitizeCivicDate } from "../dates.js";
import { parseMinutesItems, type MinutesItem } from "../validate.js";
import type {
  Locality,
  CivicSource,
  MetaFor,
  AdapterContext,
  AdapterResult,
  CivicRecord,
} from "../types.js";
import { ctxUserAgent, robotsAllows, safeFetch } from "../internal.js";
import { createRun } from "../outcome.js";
import { mapLimit } from "../concurrency.js";
import { htmlToText } from "../html.js";
import { readText, MAX_HTML_BYTES } from "../body.js";
import { readPdfText } from "./legistar.js";

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

// What the model is given per call, how much of a document we read, and how
// many items we keep. Documents longer than one call are split into
// overlapping sections; anything past the budget is dropped and reported.
const CHUNK_CHARS = 8_000;
const CHUNK_OVERLAP = 400;
const MAX_CHUNKS = 8;
const MAX_SOURCE_CHARS = CHUNK_CHARS * MAX_CHUNKS;
const PDF_MAX_PAGES = 60;
const CHUNK_CONCURRENCY = 3;
const MAX_ITEMS = 200;
/** Share of a title's words that must appear in the section it came from. */
const MIN_TITLE_OVERLAP = 0.6;

type Fetched =
  | { kind: "ok"; text: string; isPdf: boolean; problem: string | null }
  | { kind: "skipped" }
  | { kind: "error"; reason: string };

async function fetchText(url: string, ctx: AdapterContext): Promise<Fetched> {
  if (!(await robotsAllows(url, ctx))) return { kind: "skipped" };
  try {
    const res = await safeFetch(ctx, url, {
      headers: { "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { kind: "error", reason: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    const isPdf = ct.includes("pdf") || url.toLowerCase().endsWith(".pdf");
    if (isPdf) {
      const pdf = await readPdfText(url, ctx, { maxPages: PDF_MAX_PAGES, maxChars: MAX_SOURCE_CHARS });
      if (!pdf) return { kind: "error", reason: "could not read text from the PDF" };
      const notes: string[] = [];
      if (pdf.numpages !== null && pdf.pagesRead < pdf.numpages) {
        notes.push(`PDF has ${pdf.numpages} pages; only the first ${pdf.pagesRead} were read`);
      }
      if (pdf.textTruncated) notes.push(`document text truncated at ${MAX_SOURCE_CHARS} chars`);
      return {
        kind: "ok",
        text: pdf.text,
        isPdf: true,
        problem: notes.length ? `${notes.join("; ")}; items past the cut are not extracted` : null,
      };
    }
    const full = htmlToText(await readText(res, MAX_HTML_BYTES));
    return {
      kind: "ok",
      text: full.slice(0, MAX_SOURCE_CHARS),
      isPdf: false,
      problem:
        full.length > MAX_SOURCE_CHARS
          ? `page text truncated from ${full.length} to ${MAX_SOURCE_CHARS} chars; items past the cut are not extracted`
          : null,
    };
  } catch (err) {
    return { kind: "error", reason: `fetch error — ${err}` };
  }
}

/** Split into sections of at most CHUNK_CHARS that overlap by about CHUNK_OVERLAP, cutting at spaces. */
function splitIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + CHUNK_CHARS / 2) end = space;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    let next = Math.max(end - CHUNK_OVERLAP, start + 1);
    const space = text.indexOf(" ", next);
    if (space !== -1 && space < end) next = space + 1;
    start = next;
  }
  return chunks;
}

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Is this item's title actually in the text it was extracted from? Catches invented items, not paraphrase-level errors. */
function titleIsGrounded(title: string, source: Set<string>): boolean {
  const significant = wordsOf(title).filter((w) => w.length >= 3 || /\d/.test(w));
  if (significant.length === 0) return false;
  const found = significant.filter((w) => source.has(w)).length;
  return significant.length <= 2 ? found === significant.length : found / significant.length >= MIN_TITLE_OVERLAP;
}

/** A vote tally like "5-2" must be in the text; a model that rounds "passed" up to "7-0" is making it up. */
function numbersAreGrounded(result: string, source: Set<string>): boolean {
  return (result.match(/\d+/g) ?? []).every((n) => source.has(n));
}

interface SectionResult {
  error?: string;
  items: MinutesItem[];
  malformed: number;
  ungrounded: number;
  ungroundedResults: number;
}

export async function ingestHtmlMinutes(
  locality: Locality,
  source: CivicSource,
  meta: MetaFor<"html_minutes">,
  ctx: AdapterContext
): Promise<AdapterResult> {
  const run = createRun(ctx, `[${locality.name}] html_minutes:`);
  const summarize = ctx.summarize;
  if (!summarize) return run.fail("requires ctx.summarize (an LLM callback) — skipping");

  const url = meta.url ?? source.url;
  if (!url) return run.fail(`source ${source.id}: no URL`);

  const fetched = await fetchText(url, ctx);
  if (fetched.kind === "skipped") return run.skip(`${url}: disallowed by robots.txt — skipping`);
  if (fetched.kind === "error") return run.fail(`${url}: fetch failed — ${fetched.reason}`);

  // Image-only PDF detection
  if (fetched.isPdf && fetched.text.replace(/\s+/g, "").length < 100) {
    return run.fail(`${url}: image-only PDF — no text layer, skipping`);
  }
  if (fetched.problem) await run.problem(`${url}: ${fetched.problem}`);

  const chunks = splitIntoChunks(fetched.text);
  const sections = await mapLimit(chunks, CHUNK_CONCURRENCY, async (chunk): Promise<SectionResult> => {
    const empty = { items: [], malformed: 0, ungrounded: 0, ungroundedResults: 0 };
    let raw: string;
    try {
      raw = await summarize(PARSE_SYSTEM, chunk);
    } catch (err) {
      return { ...empty, error: `summarize failed — ${err}` };
    }
    const parsed = parseMinutesItems(raw);
    if (!parsed.ok) return { ...empty, error: `parse failed — ${parsed.error}` };

    const words = new Set(wordsOf(chunk));
    const out: SectionResult = { items: [], malformed: parsed.value.dropped, ungrounded: 0, ungroundedResults: 0 };
    for (const item of parsed.value.items) {
      if (!titleIsGrounded(item.title, words)) {
        out.ungrounded++;
        continue;
      }
      if (item.result && !numbersAreGrounded(item.result, words)) {
        out.ungroundedResults++;
        out.items.push({ ...item, result: null });
      } else {
        out.items.push(item);
      }
    }
    return out;
  });

  const failed = sections.filter((x) => x.error);
  if (failed.length === sections.length) {
    return run.fail(
      sections.length === 1
        ? `${url}: ${failed[0]?.error}`
        : `${url}: all ${sections.length} sections failed (first: ${failed[0]?.error})`
    );
  }
  if (failed.length > 0) {
    await run.problem(`${url}: ${failed.length} of ${sections.length} section(s) failed (first: ${failed[0]?.error})`);
  }
  const sum = (pick: (x: SectionResult) => number) => sections.reduce((n, x) => n + pick(x), 0);
  if (sum((x) => x.malformed) > 0) await run.problem(`${url}: dropped ${sum((x) => x.malformed)} malformed item(s)`);
  if (sum((x) => x.ungrounded) > 0) {
    await run.problem(`${url}: ${sum((x) => x.ungrounded)} item(s) not found in the source text, dropped`);
  }
  if (sum((x) => x.ungroundedResults) > 0) {
    await run.problem(
      `${url}: ${sum((x) => x.ungroundedResults)} result(s) had a vote count not in the source text; removed it`
    );
  }

  // Sections overlap, so the same item can come back twice: first one wins.
  const unique = new Map<string, MinutesItem>();
  for (const x of sections) {
    for (const item of x.items) {
      const key = minutesDedupeKey(source.id, url, item.title);
      if (!unique.has(key)) unique.set(key, item);
    }
  }
  if (unique.size > MAX_ITEMS) await run.problem(`${url}: kept ${MAX_ITEMS} of ${unique.size} items`);

  const records: CivicRecord[] = [];
  for (const [key, item] of [...unique].slice(0, MAX_ITEMS)) {
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
