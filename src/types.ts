// The seam contract. Adapters know nothing about your database or your app:
// they take a locality + source config, fetch and parse civic data, and hand
// normalized records to YOUR sink. Ported from a production local-news
// pipeline; the interfaces replace its app-coupled Community/Source/DB types.

/** The place an adapter is ingesting for. */
export interface Locality {
  name: string;
  city?: string;
  state?: string;
  county?: string;
  latitude?: number;
  longitude?: number;
}

export type CivicProvider =
  | "legistar"
  | "html_minutes"
  | "socrata"
  | "blotter_html"
  | "blotter_pdf"
  | "blotter_crimewatch"
  | "granicus" // recognized but STUB: no public API, manual setup required
  | "civicplus" // recognized but STUB
  | "boarddocs" // recognized but STUB
  | "usaspending"
  | "nonprofit_explorer";

export type CivicRecordType =
  | "council_meeting"
  | "permit"
  | "police_blotter"
  | "ordinance"
  | "contract"
  | "grant"
  | "inspection"
  | "violation"
  | "nonprofit_filing"
  | "legislation";

/** Per-source adapter configuration (stored however you like; often JSON on
 *  a sources table). Field meanings are provider-specific — see README. */
export interface CivicAdapterMeta {
  provider: CivicProvider;
  clientId?: string;
  url?: string;
  resourceId?: string;
  docType?: "planning_board" | "school_board" | "council";
  since?: string;

  // Socrata
  recordType?: CivicRecordType;
  dateField?: string;
  typeField?: string;
  locationField?: string;
  caseField?: string;
  descriptionField?: string;
  amountField?: string;
  titleFields?: string[];
  summaryFields?: string[];

  // HTML blotter column index overrides (0-based)
  dateCol?: number;
  typeCol?: number;
  locCol?: number;
  descCol?: number;
  caseCol?: number;

  // USASpending
  awardTypes?: "contracts" | "grants" | "all";
  lookbackDays?: number;

  // Nonprofit Explorer: comma-separated NTEE major group letters, e.g. "A,B"
  nteeFilter?: string;
}

/** The source being ingested (id is yours; url/name help some adapters). */
export interface CivicSource {
  id: string | number;
  url?: string | null;
  name?: string | null;
}

/** A normalized civic record. `dedupeKey` is stable across runs (provider +
 *  natural id + date) so sinks can upsert idempotently. */
export interface CivicRecord {
  provider: CivicProvider;
  type: CivicRecordType;
  title: string;
  /** ISO date (YYYY-MM-DD) after sanitization; null when the source date was
   *  missing, unparseable, or implausibly far in the future. */
  date: string | null;
  url?: string | null;
  summary?: string | null;
  location?: string | null;
  caseNumber?: string | null;
  amountCents?: number | null;
  dedupeKey: string;
  localityName: string;
  sourceId: string | number;
  /** The raw provider payload for consumers that want it. */
  raw?: unknown;
}

/** Where records go. Return counts so adapters can report inserted/skipped.
 *  Implementations decide dedupe semantics (dedupeKey makes upserts easy). */
export interface CivicRecordSink {
  save(records: CivicRecord[]): Promise<{ inserted: number; skipped: number }>;
}

export interface CivicLogger {
  log(message: string, level?: "info" | "warn"): void | Promise<void>;
}

/** Everything an adapter needs from the outside world. */
export interface AdapterContext {
  sink: CivicRecordSink;
  logger?: CivicLogger;
  /** Override fetch (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** User-Agent for outbound requests. Default identifies this package. */
  userAgent?: string;
  /** Skip robots.txt checking (it is ON by default; fail-open on errors). */
  skipRobotsCheck?: boolean;
  /**
   * Optional LLM hook for adapters that summarize or parse unstructured
   * text (legistar agenda summaries; REQUIRED by html_minutes, which cannot
   * parse free-form minutes without it). Bring any LLM; the docs show
   * wiring llm-governance-gateway's runText here, but nothing requires it.
   */
  summarize?: (systemPrompt: string, text: string) => Promise<string>;
}

export interface AdapterResult {
  inserted: number;
  skipped: number;
}

export const consoleLogger: CivicLogger = {
  log(message, level = "info") {
    if (level === "warn") console.warn(`[civic] ${message}`);
    else console.log(`[civic] ${message}`);
  },
};

/** In-memory sink: dedupes on dedupeKey; useful for tests and dry runs. */
export class MemorySink implements CivicRecordSink {
  readonly records = new Map<string, CivicRecord>();

  async save(records: CivicRecord[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (this.records.has(r.dedupeKey)) skipped++;
      else {
        this.records.set(r.dedupeKey, r);
        inserted++;
      }
    }
    return { inserted, skipped };
  }
}
