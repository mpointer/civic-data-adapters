// Legistar REST API client for council meeting minutes.
// Covers ~3,500 US city/county councils via https://webapi.legistar.com/v1/{clientId}/
// clientId is usually the lowercase city name; set it in meta.clientId.
import { createRequire } from "node:module";
import type {
  Locality,
  CivicSource,
  MetaFor,
  AdapterContext,
  AdapterResult,
  CivicRecord,
} from "../types.js";
import { ctxFetch, ctxUserAgent, FETCH_TIMEOUT_MS, safeFetch } from "../internal.js";
import { createRun } from "../outcome.js";
import { mapLimit } from "../concurrency.js";
import { readBytes, readJson, MAX_JSON_BYTES, MAX_PDF_BYTES } from "../body.js";
import {
  type LegistarEventItem,
  parseLegistarEvents,
  parseLegistarEventItems,
  firstAttachmentUrl,
} from "../responses.js";

const require = createRequire(import.meta.url);

const SUMMARIZE_SYSTEM = `Summarize only what is stated in this document.
If the document does not contain enough information, say so.
Do not infer or add context not present.
Write 2-3 sentences as a plain-language explanation for a local resident.`;

type FetchCtx = Pick<AdapterContext, "fetch" | "userAgent">;

// Returns the parsed body untyped; callers validate it with ../responses.ts.
async function legistarGet(clientId: string, path: string, ctx: FetchCtx): Promise<unknown> {
  const res = await ctxFetch(ctx)(
    // Granicus documents the Legistar Web API at webapi.legistar.com/v1/
    // with the client name as the first path segment. The {client}
    // .legistar.com subdomain serves the human-facing InSite portal and
    // 404s API paths (confirmed against a live client in the first smoke).
    `https://webapi.legistar.com/v1/${encodeURIComponent(clientId)}/${path}`,
    {
      headers: { Accept: "application/json", "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`Legistar ${clientId} ${path} → ${res.status}`);
  return readJson(res, MAX_JSON_BYTES);
}

export async function verifyLegistarClient(clientId: string, ctx: FetchCtx = {}): Promise<boolean> {
  try {
    await legistarGet(clientId, "Bodies?$top=1", ctx);
    return true;
  } catch {
    return false;
  }
}

export interface PdfRead {
  text: string;
  /** Pages in the document, when the parser says. */
  numpages: number | null;
  pagesRead: number;
  /** The text was cut to `maxChars`. */
  textTruncated: boolean;
}

/**
 * Fetch a PDF and extract its text, up to `maxPages` pages and `maxChars`
 * characters, and say whether it stopped short. Null on any failure or an
 * empty text layer. Not exported from the package entry point.
 */
export async function readPdfText(
  url: string,
  ctx: FetchCtx,
  opts: { maxPages?: number; maxChars?: number } = {}
): Promise<PdfRead | null> {
  const maxPages = opts.maxPages ?? 10;
  const maxChars = opts.maxChars ?? 8_000;
  try {
    const res = await safeFetch(ctx, url, {
      headers: { "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await readBytes(res, MAX_PDF_BYTES));
    // Lazy require keeps pdf-parse out of bundler static analysis and off the
    // startup path for consumers that never touch PDFs.
    const pdfParse = require("pdf-parse") as (
      b: Buffer,
      o?: { max?: number }
    ) => Promise<{ text: string; numpages?: number }>;
    const result = await pdfParse(buf, { max: maxPages });
    const text = result.text ?? "";
    if (!text) return null;
    const numpages = typeof result.numpages === "number" ? result.numpages : null;
    return {
      text: text.slice(0, maxChars),
      numpages,
      pagesRead: numpages === null ? maxPages : Math.min(numpages, maxPages),
      textTruncated: text.length > maxChars,
    };
  } catch {
    return null;
  }
}

export async function extractPdfText(url: string, ctx: FetchCtx = {}): Promise<string | null> {
  // 10 pages / 8,000 characters keeps a Legistar attachment within a token budget.
  return (await readPdfText(url, ctx))?.text || null;
}

const EVENTS_PAGE = 50;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

type EventRow = NonNullable<ReturnType<typeof parseLegistarEvents>>["rows"][number];

// Ingest Legistar council minutes for one locality/source. Fetches events
// since meta.since (ISO date; default 30 days back, up to meta.maxPages pages
// of 50), reads each meeting's agenda and summarizes each agenda item via
// ctx.summarize when provided (falling back to the item's title/action text
// when it is not), and hands records to ctx.sink. Agenda reads and per-item
// attachment/PDF/summarize work run with bounded concurrency
// (meta.concurrency); records keep event order.
export async function ingestLegistar(
  locality: Locality,
  source: CivicSource,
  meta: MetaFor<"legistar">,
  ctx: AdapterContext
): Promise<AdapterResult> {
  const run = createRun(ctx, `[${locality.name}] legistar:`);
  const clientId = meta.clientId;
  if (!clientId) return run.fail("missing clientId in source metadata");

  const since =
    meta.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const afterFilter = encodeURIComponent(`EventDate ge datetime'${since}'`);
  const maxPages = Math.max(1, Math.floor(meta.maxPages ?? DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES);
  const limit = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.floor(meta.concurrency ?? DEFAULT_CONCURRENCY) || 1)
  );

  // 1. Events, page by page, until a short page or the cap.
  const events: EventRow[] = [];
  let droppedEvents = 0;
  for (let page = 0; ; page++) {
    let parsed: ReturnType<typeof parseLegistarEvents>;
    try {
      parsed = parseLegistarEvents(
        await legistarGet(
          clientId,
          `Events?$filter=${afterFilter}&$orderby=EventDate desc&$top=${EVENTS_PAGE}&$skip=${page * EVENTS_PAGE}`,
          ctx
        )
      );
    } catch (err) {
      if (page === 0) return run.fail(`Events request failed — ${err}`);
      await run.problem(`Events page ${page + 1} failed — ${err}`);
      break;
    }
    if (!parsed) {
      if (page === 0) return run.fail(`Legistar ${clientId} Events: expected an array`);
      await run.problem(`Events page ${page + 1}: expected an array`);
      break;
    }
    events.push(...parsed.rows);
    droppedEvents += parsed.dropped;
    if (parsed.rows.length + parsed.dropped < EVENTS_PAGE) break;
    if (page + 1 >= maxPages) {
      await run.problem(
        `read ${maxPages * EVENTS_PAGE} events and there may be more — results may be incomplete; raise meta.maxPages or narrow meta.since`
      );
      break;
    }
  }
  if (droppedEvents > 0) await run.problem(`skipped ${droppedEvents} malformed event(s)`);

  let droppedItems = 0;
  let itemFetchFailures = 0;
  let enrichFailures = 0;

  // 2. Each meeting's agenda.
  const agendas = await mapLimit(events, limit, async (evt) => {
    try {
      const parsedItems = parseLegistarEventItems(
        await legistarGet(
          clientId,
          `Events/${evt.EventId}/EventItems?AgendaNote=1&MinutesNote=1`,
          ctx
        )
      );
      if (!parsedItems) throw new Error("EventItems: expected an array");
      droppedItems += parsedItems.dropped;
      return parsedItems.rows;
    } catch {
      // Still record the meeting shell, but say the agenda could not be read.
      itemFetchFailures++;
      return [] as LegistarEventItem[];
    }
  });

  // 3. One work unit per meeting shell or agenda item, in event order.
  type Unit = { evt: EventRow; item: (LegistarEventItem & { EventItemTitle: string }) | null };
  const units: Unit[] = [];
  events.forEach((evt, i) => {
    const items = agendas[i] ?? [];
    if (items.length === 0) units.push({ evt, item: null });
    else {
      for (const item of items) {
        if (item.EventItemTitle?.trim()) units.push({ evt, item: { ...item, EventItemTitle: item.EventItemTitle } });
      }
    }
  });

  const records = (
    await mapLimit(units, limit, async ({ evt, item }): Promise<CivicRecord> => {
      if (!item) return shellRecord(evt);
      return itemRecord(evt, item);
    })
  );

  async function summarizeItem(item: LegistarEventItem): Promise<string | null> {
    // Try to get a PDF for richer summarization: only worth the fetch when an
    // LLM callback is available to condense it.
    let summary: string | null = null;
    if (ctx.summarize && item.EventItemMatterFile) {
      try {
        const pdfUrl = firstAttachmentUrl(
          await legistarGet(
            clientId,
            `MatterAttachments?$filter=MatterAttachmentMatterId eq ${item.EventItemMatterFile}&$top=1`,
            ctx
          )
        );
        if (pdfUrl) {
          const pdfText = await extractPdfText(pdfUrl, ctx);
          if (pdfText) summary = await ctx.summarize(SUMMARIZE_SYSTEM, pdfText);
        }
      } catch {
        // Best-effort: the item falls back to its title text below.
        enrichFailures++;
      }
    }
    if (summary) return summary;

    // Fall back to item title + action as the summary text. Without
    // ctx.summarize the fallback text itself becomes the summary.
    const fallbackText = [
      item.EventItemTitle,
      item.EventItemActionName ? `Action: ${item.EventItemActionName}` : null,
      item.EventItemPassedFlagName ? `Result: ${item.EventItemPassedFlagName}` : null,
    ]
      .filter(Boolean)
      .join(". ");
    if (!ctx.summarize) return fallbackText || null;
    if (fallbackText.length <= 20) return null;
    try {
      return await ctx.summarize(SUMMARIZE_SYSTEM, fallbackText);
    } catch {
      enrichFailures++;
      return fallbackText;
    }
  }

  function shellRecord(evt: EventRow): CivicRecord {
    // A record for the meeting itself (no items yet, or the agenda was unreadable).
    return {
      provider: "legistar",
      type: "council_meeting",
      title: `${evt.EventBodyName ? `${evt.EventBodyName} ` : ""}Meeting — ${evt.EventDate.slice(0, 10)}`,
      summary: null,
      url: evt.EventAgendaFile ?? null,
      date: evt.EventDate.slice(0, 10),
      location: evt.EventLocation || null,
      dedupeKey: `legistar:${clientId}:${evt.EventId}:meeting`,
      localityName: locality.name,
      sourceId: source.id,
      raw: {
        meetingId: String(evt.EventId),
        body: evt.EventBodyName,
        location: evt.EventLocation,
        agendaFile: evt.EventAgendaFile,
        items: [],
      },
    };
  }

  async function itemRecord(evt: EventRow, item: LegistarEventItem & { EventItemTitle: string }): Promise<CivicRecord> {
    const summary = await summarizeItem(item);
    return {
      provider: "legistar",
      type: "council_meeting",
      title: item.EventItemTitle,
      summary,
      url: item.EventItemMatterFile
        ? `https://${clientId}.legistar.com/MatterDetail.aspx?ID=${item.EventItemMatterFile}`
        : evt.EventAgendaFile ?? null,
      date: evt.EventDate.slice(0, 10),
      dedupeKey: `legistar:${clientId}:${evt.EventId}:${item.EventItemId}`,
      localityName: locality.name,
      sourceId: source.id,
      raw: {
        meetingId: String(evt.EventId),
        body: evt.EventBodyName,
        itemId: item.EventItemId,
        action: item.EventItemActionName,
        result: item.EventItemPassedFlagName,
        matterType: item.EventItemMatterType,
      },
    };
  }

  if (droppedItems > 0) await run.problem(`skipped ${droppedItems} malformed agenda item(s)`);
  if (itemFetchFailures > 0) {
    await run.problem(`could not read the agenda for ${itemFetchFailures} meeting(s); recorded as meeting shells`);
  }
  if (enrichFailures > 0) {
    await run.problem(
      `${enrichFailures} agenda item(s) have no LLM/PDF summary because the attachment, PDF or summarize call failed`
    );
  }
  return run.done(await ctx.sink.save(records), records.length);
}
