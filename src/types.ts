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

/** Legistar Web API source. `clientId` is the {clientId}.legistar.com slug. */
export interface LegistarMeta {
  provider: "legistar";
  clientId: string;
  /** ISO date lower bound for meetings (default: 30 days back). */
  since?: string;
}

/** Free-form HTML/PDF minutes parsed by the caller's LLM (`ctx.summarize`). */
export interface HtmlMinutesMeta {
  provider: "html_minutes";
  url?: string;
  docType?: "planning_board" | "school_board" | "council";
}

/** Socrata open-data dataset. Field names are dataset-specific. */
export interface SocrataMeta {
  provider: "socrata";
  /** Portal origin, e.g. "https://data.example.gov". */
  url: string;
  /** Socrata dataset id (four-by-four), e.g. "abcd-1234". */
  resourceId: string;
  recordType?: CivicRecordType;
  since?: string;
  dateField?: string;
  typeField?: string;
  locationField?: string;
  caseField?: string;
  descriptionField?: string;
  amountField?: string;
  titleFields?: string[];
  summaryFields?: string[];
  /** Pagination cap (pages × 1000 rows). Default 20 — big-city datasets can
   *  hold millions of rows; raise deliberately for bulk pulls. */
  maxPages?: number;
}

/** HTML police-blotter table; optional 0-based column index overrides. */
export interface BlotterHtmlMeta {
  provider: "blotter_html";
  url?: string;
  recordType?: CivicRecordType;
  dateCol?: number;
  typeCol?: number;
  locCol?: number;
  descCol?: number;
  caseCol?: number;
}

/** PDF police blotter. */
export interface BlotterPdfMeta {
  provider: "blotter_pdf";
  url?: string;
  recordType?: CivicRecordType;
  since?: string;
}

/** CrimeWatch-hosted blotter (PA-centric Drupal platform). */
export interface BlotterCrimewatchMeta {
  provider: "blotter_crimewatch";
  url?: string;
  recordType?: CivicRecordType;
}

/** Recognized-but-STUB providers: no public API, manual setup required. */
export interface StubProviderMeta {
  provider: "granicus" | "civicplus" | "boarddocs";
  url?: string;
}

/** USASpending.gov awards. */
export interface UsaspendingMeta {
  provider: "usaspending";
  awardTypes?: "contracts" | "grants" | "all";
  lookbackDays?: number;
}

/** ProPublica Nonprofit Explorer. */
export interface NonprofitExplorerMeta {
  provider: "nonprofit_explorer";
  /** Comma-separated NTEE major group letters, e.g. "A,B". */
  nteeFilter?: string;
  lookbackDays?: number;
}

/**
 * Per-source adapter configuration (stored however you like; often JSON on a
 * sources table). A union discriminated on `provider`, so each provider's
 * required fields are enforced and fields from other providers don't type-check.
 * Metadata read back from a database is untyped JSON — run it through
 * `parseAdapterMeta` before trusting it.
 */
export type CivicAdapterMeta =
  | LegistarMeta
  | HtmlMinutesMeta
  | SocrataMeta
  | BlotterHtmlMeta
  | BlotterPdfMeta
  | BlotterCrimewatchMeta
  | StubProviderMeta
  | UsaspendingMeta
  | NonprofitExplorerMeta;

/** The meta type for one provider, e.g. `MetaFor<"socrata">`. */
export type MetaFor<P extends CivicProvider> = Extract<CivicAdapterMeta, { provider: P }>;

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

/** Result of a closed-set classification: one of the offered labels. */
export interface ClassifyResult {
  label: string;
  /** Calibrated confidence in `label`, 0–1. */
  probability: number;
}

/** Pick exactly one of `labels` for `text`, answering the question in `task`. */
export type ClassifyFn = (
  task: string,
  text: string,
  labels: readonly string[]
) => Promise<ClassifyResult>;

/**
 * Context for discovery functions (v0.2). Discovery PROPOSES sources via an
 * LLM callback and then VERIFIES every candidate by running the real adapter
 * parsers against it — a returned source has actually yielded data.
 */
export interface DiscoveryContext {
  /**
   * LLM callback (same shape as AdapterContext.summarize). The prompts ask
   * for real, current URLs, so for useful results this should be backed by
   * WEB-SEARCH-GROUNDED generation. An ungrounded model will hallucinate
   * candidates; verification rejects them, which is safe but yields nothing.
   */
  generate: (systemPrompt: string, prompt: string) => Promise<string>;
  /**
   * Optional closed-set classifier used as an EXTRA gate on candidates that
   * already passed the deterministic parsers (e.g. rows parsed from a table
   * that turns out to be a staff directory, not a blotter). Back it with
   * anything that returns a label plus a probability — a small calibrated
   * classifier is a good fit, a general LLM works too. When absent, behavior
   * is unchanged. When it throws, discovery fails open (parser verification
   * stands) and logs a warning.
   */
  classify?: ClassifyFn;
  fetch?: typeof fetch;
  userAgent?: string;
  logger?: CivicLogger;
  skipRobotsCheck?: boolean;
}

/** A verified, ready-to-ingest source proposal. `meta` drops straight into
 *  `runAdapter`. Discovery proposes; humans approve; adapters ingest. */
export interface DiscoveredSource {
  provider: CivicProvider;
  name: string;
  url?: string;
  meta: CivicAdapterMeta;
  /** How verification confirmed it, e.g. "parsed 12 blotter rows just now"
   *  or "Legistar API answered for clientId 'seattle'". */
  evidence: string;
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
