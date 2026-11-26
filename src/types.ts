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
  /** Requests (and `summarize` calls) in flight at once. Default 4, clamped to 1-8. */
  concurrency?: number;
  /** Pages of 50 events to read (default 4, so up to 200 events). Hitting the cap is reported as `partial`. */
  maxPages?: number;
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

/**
 * Retry policy for outbound requests. Every field is optional. Requests that
 * get 429, 502, 503 or 504, or fail with a network error or timeout, are
 * retried with exponential backoff and jitter, honoring `Retry-After`.
 */
export interface HttpPolicy {
  /** Retries after the first attempt (default 3). 0 turns retrying off. */
  retries?: number;
  /** First backoff in ms; doubles each retry (default 500). */
  baseDelayMs?: number;
  /** Longest single wait in ms (default 30000). A longer `Retry-After` is not waited out: the response is returned. */
  maxDelayMs?: number;
  /** Test seams: replace the clock, the sleeper and the jitter source. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** Everything an adapter needs from the outside world. */
export interface AdapterContext {
  sink: CivicRecordSink;
  logger?: CivicLogger;
  /** Override fetch (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** User-Agent for outbound requests. Default identifies this package. */
  userAgent?: string;
  /** Retry and backoff for outbound requests; see HttpPolicy. */
  http?: HttpPolicy;
  /** Structured events for metrics and tracing; see CivicEventHandler. */
  onEvent?: CivicEventHandler;
  /** Skip robots.txt checking (it is ON by default; fail-open on errors). */
  skipRobotsCheck?: boolean;
  /**
   * Bring-your-own robots.txt check. When provided, this runs INSTEAD of
   * the package's bundled checker (and `skipRobotsCheck` is irrelevant).
   * Return true to allow the request. For consumers that already have a
   * tested, possibly-cached robots implementation and want the package's
   * request-gating without a second, redundant robots.txt fetch. Same
   * pattern as the `summarize` hook: the package's other reach-out-to-the-
   * network-on-your-behalf seam, made injectable.
   */
  robotsCheck?: (url: string) => Promise<boolean>;
  /**
   * Optional LLM hook for adapters that summarize or parse unstructured
   * text (legistar agenda summaries; REQUIRED by html_minutes, which cannot
   * parse free-form minutes without it). Bring any LLM; the docs show
   * wiring llm-governance-gateway's runText here, but nothing requires it.
   */
  summarize?: (systemPrompt: string, text: string) => Promise<string>;
}

/**
 * What happened to a run:
 *  - `ok`: ran to the end. Zero records is still ok: a quiet day is not a failure.
 *  - `partial`: saved some data, but something was lost (page cap or time budget
 *    hit, a page or row failed, malformed rows dropped). See `problems`.
 *  - `failed`: could not get data (HTTP or fetch error, wrong response shape,
 *    nothing parseable, missing or invalid config). Nothing was saved.
 *  - `skipped`: deliberately did not run (robots.txt refusal, provider that is a stub).
 */
export type AdapterStatus = "ok" | "partial" | "failed" | "skipped";

/** What a run cost, counted whether or not anyone listens for events. */
export interface RunStats {
  durationMs: number;
  /** HTTP attempts, retries included. */
  requests: number;
  /** Attempts that were retries. */
  retries: number;
  /** Calls to the `summarize` callback. */
  llmCalls: number;
}

export interface AdapterResult {
  inserted: number;
  skipped: number;
  status: AdapterStatus;
  /** Human-readable, one per distinct problem. Empty when `status` is "ok". */
  problems: string[];
  stats: RunStats;
}

/**
 * Structured events for metrics, traces and logs; see `onEvent`. They carry
 * hosts, paths, statuses, counts and timings. They never carry a query string,
 * a request body, a record, or LLM input or output.
 */
export type CivicEventPayload =
  | { type: "run.start" }
  | {
      type: "run.end";
      status: AdapterStatus;
      inserted: number;
      skipped: number;
      /** How many problems the run recorded (their text is in `problem` events and the result). */
      problems: number;
      stats: RunStats;
    }
  /** A sink error (or other bug) ended the run by throwing. */
  | { type: "run.error"; message: string }
  | { type: "problem"; message: string }
  | {
      type: "http.attempt";
      host: string;
      method: string;
      /** The path only: never the query string. */
      path: string;
      /** Absent when the attempt failed before a response. */
      status?: number;
      error?: string;
      durationMs: number;
      /** 1 for the first try. */
      attempt: number;
    }
  | { type: "http.retry"; host: string; reason: string; waitMs: number; attempt: number };

/** An event plus when it happened and which run it belongs to (absent outside a run, e.g. discovery). */
export type CivicEvent = CivicEventPayload & {
  /** Milliseconds since the epoch. */
  ts: number;
  runId?: string;
  provider?: string;
  locality?: string;
  sourceId?: string | number;
};

/**
 * Receives structured events. Called synchronously and never awaited; an
 * exception or a rejected promise from it is swallowed so telemetry cannot
 * break a run. Keep it fast: hand off to your logger, metrics or tracer.
 */
export type CivicEventHandler = (event: CivicEvent) => void | Promise<void>;

/**
 * Answer a yes/no `question` about `text` with the probability (0–1) that the
 * answer is yes. Maps directly onto a calibrated yes/no endpoint such as
 * Jev's "noul" question type.
 */
export type VerifyFn = (question: string, text: string) => Promise<number>;

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
   * Optional yes/no verifier used as an EXTRA gate on candidates that already
   * passed the deterministic parsers (e.g. rows parsed from a table that turns
   * out to be a staff directory, not a blotter). Returns the probability of
   * yes. p >= `verifyThresholds.yes` (default 0.7) accepts; p <= `.no`
   * (default 0.3) rejects; in between the candidate is returned only if no
   * confident one is found, flagged `needsReview`. When absent, behavior is
   * unchanged. When it throws or returns a score outside 0–1, discovery fails
   * open (parser verification stands) and logs a warning.
   */
  verify?: VerifyFn;
  /** Override the accept/reject cut-offs for `verify`. Requires no < yes. */
  verifyThresholds?: { yes?: number; no?: number };
  fetch?: typeof fetch;
  userAgent?: string;
  http?: HttpPolicy;
  onEvent?: CivicEventHandler;
  logger?: CivicLogger;
  skipRobotsCheck?: boolean;
  /** Bring-your-own robots.txt check; see AdapterContext.robotsCheck. */
  robotsCheck?: (url: string) => Promise<boolean>;
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
  /** True when `verify` was uncertain: a human should confirm before ingest. */
  needsReview?: boolean;
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
