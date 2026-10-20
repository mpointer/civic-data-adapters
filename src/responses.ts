// Runtime parsers for third-party API responses. Adapters used to cast
// `res.json() as SomeType`, which promises shapes the code never checks: one
// null date or an error payload served with a 200 became a TypeError that
// aborted the whole run, and a row missing its id was keyed `…:undefined`,
// silently collapsing every such row onto one dedupe key.
//
// Contract: a parser returns `null` when the payload is structurally wrong
// (not the array/object the endpoint documents), so the caller decides whether
// that is fatal or a warning. Individual bad rows are skipped and counted in
// `dropped`, so one malformed record never costs the rest of the batch. Fields
// that are merely optional or null stay null; only fields an adapter cannot do
// without (ids, dates it slices) are required.
import { isRecord } from "./validate.js";

/** A non-blank string, else null. The original string is returned unmodified. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** A finite number, or a plain decimal string (amounts are sometimes quoted). */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

/** Integer-like id: a finite number, or a string of digits. */
function intId(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v);
  return null;
}

/** String id: a non-blank string, or a finite number rendered as a string. */
function strId(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v);
}

export interface Parsed<T> {
  rows: T[];
  /** Entries skipped because they were not objects or lacked a required field. */
  dropped: number;
}

function parseRows<T>(body: unknown, parseRow: (row: Record<string, unknown>) => T | null): Parsed<T> | null {
  if (!Array.isArray(body)) return null;
  const rows: T[] = [];
  let dropped = 0;
  for (const entry of body) {
    const row = isRecord(entry) ? parseRow(entry) : null;
    if (row) rows.push(row);
    else dropped++;
  }
  return { rows, dropped };
}

// ── Legistar ────────────────────────────────────────────────────────────────

export interface LegistarEvent {
  EventId: number;
  /** Always begins with YYYY-MM-DD. */
  EventDate: string;
  EventBodyName: string | null;
  EventLocation: string | null;
  EventAgendaFile: string | null;
}

export interface LegistarEventItem {
  EventItemId: number;
  EventItemTitle: string | null;
  EventItemActionName: string | null;
  EventItemPassedFlagName: string | null;
  EventItemMatterFile: string | null;
  EventItemMatterType: string | null;
}

/** `Events` endpoint: an array. Rows need a numeric id and an ISO-prefixed date. */
export function parseLegistarEvents(body: unknown): Parsed<LegistarEvent> | null {
  return parseRows(body, (r) => {
    const id = intId(r.EventId);
    const date = str(r.EventDate);
    if (id === null || !date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
    return {
      EventId: id,
      EventDate: date,
      EventBodyName: str(r.EventBodyName),
      EventLocation: str(r.EventLocation),
      EventAgendaFile: str(r.EventAgendaFile),
    };
  });
}

/** `Events/{id}/EventItems`: an array. Rows need a numeric id; a blank title is
 *  left for the adapter to skip, as it always has. */
export function parseLegistarEventItems(body: unknown): Parsed<LegistarEventItem> | null {
  return parseRows(body, (r) => {
    const id = intId(r.EventItemId);
    if (id === null) return null;
    return {
      EventItemId: id,
      EventItemTitle: typeof r.EventItemTitle === "string" ? r.EventItemTitle : null,
      EventItemActionName: str(r.EventItemActionName),
      EventItemPassedFlagName: str(r.EventItemPassedFlagName),
      EventItemMatterFile: strId(r.EventItemMatterFile),
      EventItemMatterType: str(r.EventItemMatterType),
    };
  });
}

/** `MatterAttachments`: the first attachment's hyperlink, if the payload has one. */
export function firstAttachmentUrl(body: unknown): string | null {
  const first: unknown = Array.isArray(body) ? body[0] : undefined;
  return isRecord(first) ? str(first.MatterAttachmentHyperlink) : null;
}

// ── USASpending ─────────────────────────────────────────────────────────────

// Keys are the field names the endpoint actually returns (see usaspending.ts).
export interface USASpendingAward {
  "Award ID": string;
  "Recipient Name": string | null;
  "Award Amount": number | null;
  Description: string | null;
  "Awarding Agency": string | null;
  "Start Date": string | null;
}

export interface USASpendingPage {
  awards: USASpendingAward[];
  dropped: number;
  hasNextPage: boolean;
}

/** `spending_by_award`: `{ results: [], page_metadata: { has_next_page } }`.
 *  Awards without an id are dropped; a missing `page_metadata` means last page. */
export function parseUSASpendingPage(body: unknown): USASpendingPage | null {
  if (!isRecord(body)) return null;
  const parsed = parseRows(body.results, (r) => {
    const id = strId(r["Award ID"]);
    if (!id) return null;
    return {
      "Award ID": id,
      "Recipient Name": str(r["Recipient Name"]),
      "Award Amount": num(r["Award Amount"]),
      Description: str(r.Description),
      "Awarding Agency": str(r["Awarding Agency"]),
      "Start Date": str(r["Start Date"]),
    };
  });
  if (!parsed) return null;
  const meta = body.page_metadata;
  return {
    awards: parsed.rows,
    dropped: parsed.dropped,
    hasNextPage: isRecord(meta) && meta.has_next_page === true,
  };
}

// ── ProPublica Nonprofit Explorer ───────────────────────────────────────────

export interface PropublicaOrg {
  /** Kept as the API sent it (a number in practice) so `raw.ein` is unchanged. */
  ein: string | number;
  name: string;
  city: string | null;
  state: string | null;
  ntee_code: string | null;
  income_amount: number | null;
  asset_amount: number | null;
  filing_date: string | null;
  form_type: string | null;
}

export interface PropublicaPage {
  orgs: PropublicaOrg[];
  dropped: number;
  /** null when the response omitted a usable `num_pages`. */
  numPages: number | null;
}

/** `search.json`: `{ num_pages, organizations: [] }`. Orgs need an ein and a name. */
export function parsePropublicaPage(body: unknown): PropublicaPage | null {
  if (!isRecord(body)) return null;
  const parsed = parseRows(body.organizations, (r) => {
    const ein = strId(r.ein);
    const name = str(r.name);
    if (!ein || !name) return null;
    return {
      ein: typeof r.ein === "number" ? r.ein : ein,
      name,
      city: str(r.city),
      state: str(r.state),
      ntee_code: str(r.ntee_code),
      income_amount: num(r.income_amount),
      asset_amount: num(r.asset_amount),
      filing_date: str(r.filing_date),
      form_type: str(r.form_type),
    };
  });
  if (!parsed) return null;
  const pages = num(body.num_pages);
  return {
    orgs: parsed.rows,
    dropped: parsed.dropped,
    numPages: pages !== null && pages >= 0 ? Math.floor(pages) : null,
  };
}
