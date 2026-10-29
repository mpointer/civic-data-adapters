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
import { ctxFetch, ctxUserAgent, FETCH_TIMEOUT_MS } from "../internal.js";
import { createRun } from "../outcome.js";
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
  return res.json();
}

export async function verifyLegistarClient(clientId: string, ctx: FetchCtx = {}): Promise<boolean> {
  try {
    await legistarGet(clientId, "Bodies?$top=1", ctx);
    return true;
  } catch {
    return false;
  }
}

export async function extractPdfText(url: string, ctx: FetchCtx = {}): Promise<string | null> {
  try {
    const res = await ctxFetch(ctx)(url, {
      headers: { "User-Agent": ctxUserAgent(ctx) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Lazy require keeps pdf-parse out of bundler static analysis and off the
    // startup path for consumers that never touch PDFs.
    const pdfParse = require("pdf-parse") as (
      b: Buffer,
      o?: { max?: number }
    ) => Promise<{ text: string }>;
    const result = await pdfParse(buf, { max: 10 }); // cap at 10 pages
    return result.text?.slice(0, 8_000) || null; // keep within token budget
  } catch {
    return null;
  }
}

// Ingest Legistar council minutes for one locality/source. Fetches events
// since meta.since (ISO date; default 30 days back), summarizes each agenda
// item via ctx.summarize when provided (falling back to the item's
// title/action text when it is not), and hands records to ctx.sink.
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
  let parsedEvents: ReturnType<typeof parseLegistarEvents>;
  try {
    parsedEvents = parseLegistarEvents(
      await legistarGet(
        clientId,
        `Events?$filter=${afterFilter}&$orderby=EventDate desc&$top=50`,
        ctx
      )
    );
  } catch (err) {
    return run.fail(`Events request failed — ${err}`);
  }
  if (!parsedEvents) return run.fail(`Legistar ${clientId} Events: expected an array`);
  if (parsedEvents.dropped > 0) {
    await run.problem(`skipped ${parsedEvents.dropped} malformed event(s)`);
  }
  let droppedItems = 0;
  let itemFetchFailures = 0;
  let enrichFailures = 0;

  const records: CivicRecord[] = [];

  for (const evt of parsedEvents.rows) {
    // Fetch agenda items for this meeting
    let items: LegistarEventItem[] = [];
    try {
      const parsedItems = parseLegistarEventItems(
        await legistarGet(
          clientId,
          `Events/${evt.EventId}/EventItems?AgendaNote=1&MinutesNote=1`,
          ctx
        )
      );
      if (!parsedItems) throw new Error("EventItems: expected an array");
      items = parsedItems.rows;
      droppedItems += parsedItems.dropped;
    } catch {
      // Still record the meeting shell, but say the agenda could not be read.
      itemFetchFailures++;
    }

    if (items.length === 0) {
      // Record a shell for the meeting itself (no items yet)
      records.push({
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
      });
      continue;
    }

    // One record per agenda item
    for (const item of items) {
      if (!item.EventItemTitle?.trim()) continue;

      // Try to get a PDF for richer summarization — only worth the fetch when
      // an LLM callback is available to condense it.
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
            if (pdfText) {
              summary = await ctx.summarize(SUMMARIZE_SYSTEM, pdfText);
            }
          }
        } catch {
          // Best-effort: the item falls back to its title text below.
          enrichFailures++;
        }
      }

      // Fall back to item title + action as the summary text. Without
      // ctx.summarize the fallback text itself becomes the summary.
      if (!summary && item.EventItemTitle) {
        const fallbackText = [
          item.EventItemTitle,
          item.EventItemActionName ? `Action: ${item.EventItemActionName}` : null,
          item.EventItemPassedFlagName ? `Result: ${item.EventItemPassedFlagName}` : null,
        ]
          .filter(Boolean)
          .join(". ");
        if (ctx.summarize) {
          if (fallbackText.length > 20) {
            try {
              summary = await ctx.summarize(SUMMARIZE_SYSTEM, fallbackText);
            } catch {
              enrichFailures++;
              summary = fallbackText;
            }
          }
        } else {
          summary = fallbackText || null;
        }
      }

      records.push({
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
      });
    }
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
