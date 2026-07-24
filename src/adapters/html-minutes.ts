// Council meeting minutes/agenda parser for plain HTML or PDF pages. Free-form
// minutes have no reliable structure, so this adapter REQUIRES ctx.summarize
// (an LLM callback) to extract structured action items; without it the
// adapter logs a warning and skips.
import type {
  Locality,
  CivicSource,
  CivicAdapterMeta,
  AdapterContext,
  AdapterResult,
  CivicRecord,
} from "../types.js";
import { ctxFetch, ctxUserAgent, robotsAllows } from "../internal.js";
import { extractPdfText } from "./legistar.js";

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

async function fetchText(
  url: string,
  ctx: AdapterContext
): Promise<{ text: string; isPdf: boolean } | null> {
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
      return text ? { text, isPdf: true } : null;
    }
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8_000);
    return { text, isPdf: false };
  } catch {
    return null;
  }
}

interface RawActionItem {
  title?: string;
  action?: string | null;
  result?: string | null;
  date?: string | null;
}

export async function ingestHtmlMinutes(
  locality: Locality,
  source: CivicSource,
  meta: CivicAdapterMeta,
  ctx: AdapterContext
): Promise<AdapterResult> {
  if (!ctx.summarize) {
    ctx.logger?.log(
      "html_minutes requires ctx.summarize (an LLM callback) — skipping",
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  const url = meta.url ?? source.url;
  if (!url) {
    await ctx.logger?.log(`[${locality.name}] html_minutes source ${source.id}: no URL`, "warn");
    return { inserted: 0, skipped: 0 };
  }

  const fetched = await fetchText(url, ctx);
  if (!fetched) {
    await ctx.logger?.log(`[${locality.name}] html_minutes ${url}: fetch failed`, "warn");
    return { inserted: 0, skipped: 0 };
  }

  // Image-only PDF detection
  if (fetched.isPdf && fetched.text.replace(/\s+/g, "").length < 100) {
    await ctx.logger?.log(
      `[${locality.name}] html_minutes ${url}: image-only PDF — no text layer, skipping`,
      "warn"
    );
    return { inserted: 0, skipped: 0 };
  }

  let items: RawActionItem[] = [];
  try {
    const raw = await ctx.summarize(PARSE_SYSTEM, fetched.text);
    const json = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    items = JSON.parse(json) as RawActionItem[];
    if (!Array.isArray(items)) items = [];
  } catch {
    await ctx.logger?.log(`[${locality.name}] html_minutes ${url}: parse failed`, "warn");
    return { inserted: 0, skipped: 0 };
  }

  const records: CivicRecord[] = [];
  for (const item of items.slice(0, 50)) {
    if (!item.title?.trim()) continue;
    // Deterministic dedup key: source id + content hash
    const key = `htmlminutes:${source.id}:${Buffer.from(item.title).toString("base64").slice(0, 12)}`;
    records.push({
      provider: "html_minutes",
      type: "council_meeting",
      title: item.title.trim(),
      summary: [item.action, item.result].filter(Boolean).join(" — ") || null,
      date: item.date ?? null,
      url,
      dedupeKey: key,
      localityName: locality.name,
      sourceId: source.id,
    });
  }

  return ctx.sink.save(records);
}
