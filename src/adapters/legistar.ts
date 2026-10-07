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
import { ctxFetch, ctxUserAgent } from "../internal.js";

const require = createRequire(import.meta.url);

const SUMMARIZE_SYSTEM = `Summarize only what is stated in this document.
If the document does not contain enough information, say so.
Do not infer or add context not present.
Write 2-3 sentences as a plain-language explanation for a local resident.`;

interface LegistarEvent {
  EventId: number;
  EventDate: string;
  EventTime: string;
  EventBodyName: string;
  EventLocation: string;
  EventAgendaStatusName: string;
  EventAgendaFile?: string;
  EventMinutesFile?: string;
}

interface LegistarEventItem {
  EventItemId: number;
  EventItemTitle: string;
  EventItemActionName?: string;
  EventItemPassedFlagName?: string;
  EventItemMatterFile?: string;
  EventItemMatterName?: string;
  EventItemMatterType?: string;
  EventItemAgendaSequence?: number;
}

interface LegistarMatterAttachment {
  MatterAttachmentId: number;
  MatterAttachmentName: string;
  MatterAttachmentHyperlink: string;
}

type FetchCtx = Pick<AdapterContext, "fetch" | "userAgent">;

async function legistarGet<T>(clientId: string, path: string, ctx: FetchCtx): Promise<T> {
  const res = await ctxFetch(ctx)(
    // Granicus documents the Legistar Web API at webapi.legistar.com/v1/
    // with the client name as the first path segment. The {client}
    // .legistar.com subdomain serves the human-facing InSite portal and
    // 404s API paths (confirmed against a live client in the first smoke).
    `https://webapi.legistar.com/v1/${encodeURIComponent(clientId)}/${path}`,
    { headers: { Accept: "application/json", "User-Agent": ctxUserAgent(ctx) } }
  );
  if (!res.ok) throw new Error(`Legistar ${clientId} ${path} → ${res.status}`);
  return res.json() as Promise<T>;
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
  const clientId = meta.clientId;
  if (!clientId) {
    await ctx.logger?.log(
      `[${locality.name}] legistar: missing clientId in source metadata`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  const since =
    meta.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const afterFilter = encodeURIComponent(`EventDate ge datetime'${since}'`);
  const events = await legistarGet<LegistarEvent[]>(
    clientId,
    `Events?$filter=${afterFilter}&$orderby=EventDate desc&$top=50`,
    ctx
  );

  const records: CivicRecord[] = [];

  for (const evt of events) {
    // Fetch agenda items for this meeting
    let items: LegistarEventItem[] = [];
    try {
      items = await legistarGet<LegistarEventItem[]>(
        clientId,
        `Events/${evt.EventId}/EventItems?AgendaNote=1&MinutesNote=1`,
        ctx
      );
    } catch {
      // Event with no items (cancelled, future-only) — still record the meeting shell
    }

    if (items.length === 0) {
      // Record a shell for the meeting itself (no items yet)
      records.push({
        provider: "legistar",
        type: "council_meeting",
        title: `${evt.EventBodyName} Meeting — ${evt.EventDate.slice(0, 10)}`,
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
          const attachments = await legistarGet<LegistarMatterAttachment[]>(
            clientId,
            `MatterAttachments?$filter=MatterAttachmentMatterId eq ${item.EventItemMatterFile}&$top=1`,
            ctx
          );
          const pdfUrl = attachments[0]?.MatterAttachmentHyperlink;
          if (pdfUrl) {
            const pdfText = await extractPdfText(pdfUrl, ctx);
            if (pdfText) {
              summary = await ctx.summarize(SUMMARIZE_SYSTEM, pdfText);
            }
          }
        } catch {
          // PDF extraction is best-effort
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
            summary = await ctx.summarize(SUMMARIZE_SYSTEM, fallbackText);
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

  return ctx.sink.save(records);
}
