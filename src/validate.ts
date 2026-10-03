// Runtime validation at the package's trust boundaries. TypeScript types are
// erased at runtime, and two inputs are untyped by nature: adapter metadata
// read back from a database as JSON, and JSON an LLM was asked to produce.
// Hand-rolled guards (no schema library) keep the package dependency-light.
import type { CivicAdapterMeta, CivicProvider } from "./types.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const RECORD_TYPES = [
  "council_meeting",
  "permit",
  "police_blotter",
  "ordinance",
  "contract",
  "grant",
  "inspection",
  "violation",
  "nonprofit_filing",
  "legislation",
] as const;

/** A field is a primitive kind, or a closed set of allowed string values. */
type FieldType = "string" | "number" | "string[]" | readonly string[];

interface MetaSpec {
  required?: readonly string[];
  fields: Record<string, FieldType>;
}

const URL_FIELD = { url: "string" } as const;
const BLOTTER_FIELDS = { ...URL_FIELD, recordType: RECORD_TYPES } as const;

const META_SPECS: Record<CivicProvider, MetaSpec> = {
  legistar: { required: ["clientId"], fields: { clientId: "string", since: "string" } },
  html_minutes: {
    fields: { ...URL_FIELD, docType: ["planning_board", "school_board", "council"] },
  },
  socrata: {
    required: ["url", "resourceId"],
    fields: {
      url: "string",
      resourceId: "string",
      recordType: RECORD_TYPES,
      since: "string",
      dateField: "string",
      typeField: "string",
      locationField: "string",
      caseField: "string",
      descriptionField: "string",
      amountField: "string",
      titleFields: "string[]",
      summaryFields: "string[]",
      maxPages: "number",
    },
  },
  blotter_html: {
    fields: {
      ...BLOTTER_FIELDS,
      dateCol: "number",
      typeCol: "number",
      locCol: "number",
      descCol: "number",
      caseCol: "number",
    },
  },
  blotter_pdf: { fields: { ...BLOTTER_FIELDS, since: "string" } },
  blotter_crimewatch: { fields: BLOTTER_FIELDS },
  granicus: { fields: URL_FIELD },
  civicplus: { fields: URL_FIELD },
  boarddocs: { fields: URL_FIELD },
  usaspending: {
    fields: { awardTypes: ["contracts", "grants", "all"], lookbackDays: "number" },
  },
  nonprofit_explorer: { fields: { nteeFilter: "string", lookbackDays: "number" } },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fieldError(value: unknown, type: FieldType): string | null {
  if (type === "string") return typeof value === "string" ? null : "expected a string";
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value) ? null : "expected a finite number";
  }
  if (type === "string[]") {
    return Array.isArray(value) && value.every((x) => typeof x === "string")
      ? null
      : "expected an array of strings";
  }
  return typeof value === "string" && type.includes(value)
    ? null
    : `expected one of ${type.join(", ")}`;
}

/**
 * Validate untyped adapter metadata (e.g. JSON from a sources table) and
 * narrow it to `CivicAdapterMeta`. Unknown keys are dropped; `null` values are
 * treated as absent (JSON columns often store nulls). Fails on an unknown
 * provider, a missing required field, or a field of the wrong type.
 */
export function parseAdapterMeta(input: unknown): ParseResult<CivicAdapterMeta> {
  if (!isRecord(input)) return { ok: false, error: "meta must be an object" };
  const provider = input.provider;
  if (typeof provider !== "string" || !Object.hasOwn(META_SPECS, provider)) {
    return { ok: false, error: `unknown provider '${String(provider)}'` };
  }
  const spec = META_SPECS[provider as CivicProvider];

  const out: Record<string, unknown> = { provider };
  for (const [key, type] of Object.entries(spec.fields)) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    const err = fieldError(value, type);
    if (err) return { ok: false, error: `${provider}.${key}: ${err}` };
    out[key] = value;
  }
  for (const key of spec.required ?? []) {
    const value = out[key];
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, error: `${provider}.${key} is required` };
    }
  }
  return { ok: true, value: out as unknown as CivicAdapterMeta };
}

/**
 * Pull a JSON array out of an LLM reply. Models asked for "ONLY a JSON array"
 * still often wrap it in a markdown fence or a sentence of prose, so try the
 * cleaned text first, then the outermost [...] slice. Returns null when no
 * array can be parsed.
 */
export function extractJsonArray(raw: string): unknown[] | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  for (const text of [cleaned, cleaned.slice(cleaned.indexOf("["), cleaned.lastIndexOf("]") + 1)]) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** One validated agenda/minutes action item extracted by the LLM. */
export interface MinutesItem {
  title: string;
  action: string | null;
  result: string | null;
  /** YYYY-MM-DD, or null if the model's date wasn't in that shape. */
  date: string | null;
}

function optionalString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Validate the JSON array `html_minutes` asks the model for. Entries without a
 * non-empty string title are dropped (counted in `dropped`); other fields are
 * coerced to string-or-null. `ok: false` means the reply held no JSON array
 * at all — distinct from a valid-but-empty array.
 */
export function parseMinutesItems(
  raw: string
): ParseResult<{ items: MinutesItem[]; dropped: number }> {
  const arr = extractJsonArray(raw);
  if (!arr) return { ok: false, error: "no JSON array in model output" };

  const items: MinutesItem[] = [];
  let dropped = 0;
  for (const entry of arr) {
    const title = isRecord(entry) ? optionalString(entry.title) : null;
    if (!isRecord(entry) || !title) {
      dropped++;
      continue;
    }
    const date = typeof entry.date === "string" ? /^\d{4}-\d{2}-\d{2}/.exec(entry.date)?.[0] : undefined;
    items.push({
      title,
      action: optionalString(entry.action),
      result: optionalString(entry.result),
      date: date ?? null,
    });
  }
  return { ok: true, value: { items, dropped } };
}
