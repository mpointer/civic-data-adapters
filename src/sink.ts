// The boundary between adapters and the consumer's storage: validate what goes
// in, hand the sink bounded batches, check what comes back, and say how far a
// failure got. Not exported from the package entry point except for the
// conformance check and the error type.
import { randomUUID } from "node:crypto";
import type { AdapterContext, CivicRecord, CivicRecordSink, SaveResult } from "./types.js";
import type { Run } from "./outcome.js";
import { emit, scrub } from "./telemetry.js";

const DEFAULT_BATCH = 500;
const MAX_BATCH = 5_000;

/** The sink threw, or returned something that is not a SaveResult. Says how far the save got. */
export class CivicSinkError extends Error {
  readonly saved: SaveResult;
  readonly unsaved: number;
  readonly batch: number;
  readonly batches: number;
  override readonly cause: unknown;
  constructor(message: string, info: { saved: SaveResult; unsaved: number; batch: number; batches: number; cause?: unknown }) {
    super(message);
    this.name = "CivicSinkError";
    this.saved = info.saved;
    this.unsaved = info.unsaved;
    this.batch = info.batch;
    this.batches = info.batches;
    this.cause = info.cause;
  }
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** A SaveResult with non-negative integer counts, or null. */
function readSaveResult(value: unknown): SaveResult | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isCount(v.inserted) || !isCount(v.skipped)) return null;
  if (v.updated !== undefined && !isCount(v.updated)) return null;
  return v.updated === undefined ? { inserted: v.inserted, skipped: v.skipped } : { inserted: v.inserted, skipped: v.skipped, updated: v.updated };
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function isRealIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

interface Prepared {
  records: CivicRecord[];
  invalid: number;
  duplicates: number;
  datesCleared: number;
  urlsCleared: number;
}

/**
 * What a database needs of a record: identity fields present, one record per
 * dedupeKey, a real calendar date or none, an http(s) url or none. Returns
 * copies; the caller's records are not modified.
 */
function prepare(input: readonly CivicRecord[]): Prepared {
  const out: CivicRecord[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;
  let datesCleared = 0;
  let urlsCleared = 0;
  for (const r of input) {
    const ok =
      typeof r === "object" &&
      r !== null &&
      nonEmpty(r.dedupeKey) &&
      nonEmpty(r.title) &&
      nonEmpty(r.provider) &&
      nonEmpty(r.type) &&
      nonEmpty(r.localityName) &&
      (nonEmpty(r.sourceId) || typeof r.sourceId === "number");
    if (!ok) {
      invalid++;
      continue;
    }
    if (seen.has(r.dedupeKey)) {
      duplicates++;
      continue;
    }
    seen.add(r.dedupeKey);
    let copy = r;
    if (r.date != null && !(typeof r.date === "string" && isRealIsoDate(r.date))) {
      copy = { ...copy, date: null };
      datesCleared++;
    }
    if (r.url != null && !(typeof r.url === "string" && isHttpUrl(r.url))) {
      copy = { ...copy, url: null };
      urlsCleared++;
    }
    out.push(copy);
  }
  return { records: out, invalid, duplicates, datesCleared, urlsCleared };
}

function batchSizeOf(ctx: Pick<AdapterContext, "sinkBatchSize">): number {
  const n = ctx.sinkBatchSize;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return DEFAULT_BATCH;
  return Math.min(MAX_BATCH, Math.floor(n));
}

/**
 * Save an adapter's records through `ctx.sink`: prepare them, send them in
 * batches, validate each reply, add up the results. A bad record is dropped
 * and recorded as a problem on `run`; a sink that throws or misreports ends
 * the call with a CivicSinkError carrying how much was saved before it.
 * An empty list does not call the sink.
 */
export async function saveRecords(
  ctx: Pick<AdapterContext, "sink" | "sinkBatchSize" | "onEvent">,
  run: Run,
  records: readonly CivicRecord[]
): Promise<SaveResult> {
  const prepared = prepare(records);
  if (prepared.invalid > 0) await run.problem(`dropped ${prepared.invalid} invalid record(s) (missing a required field)`);
  if (prepared.datesCleared > 0) await run.problem(`cleared an unreadable date on ${prepared.datesCleared} record(s)`);
  if (prepared.urlsCleared > 0) await run.problem(`cleared a non-http(s) url on ${prepared.urlsCleared} record(s)`);

  const size = batchSizeOf(ctx);
  const batches = Math.ceil(prepared.records.length / size);
  const total: { inserted: number; skipped: number; updated: number; sawUpdated: boolean } = {
    inserted: 0,
    skipped: prepared.duplicates, // a repeat within the call is "already there", as a sink would say
    updated: 0,
    sawUpdated: false,
  };
  const progress = (): SaveResult => ({ inserted: total.inserted, skipped: total.skipped, ...(total.sawUpdated ? { updated: total.updated } : {}) });
  let sent = 0;

  for (let i = 0; i < batches; i++) {
    const batch = prepared.records.slice(i * size, (i + 1) * size);
    const where = `batch ${i + 1} of ${batches}`;
    const startedAt = Date.now();
    let reply: unknown;
    try {
      reply = await ctx.sink.save(batch);
    } catch (err) {
      const msg = scrub(err instanceof Error ? err.message : String(err));
      throw new CivicSinkError(`sink.save failed on ${where}: ${msg}`, {
        saved: progress(),
        unsaved: prepared.records.length - sent,
        batch: i + 1,
        batches,
        cause: err,
      });
    }
    const result = readSaveResult(reply);
    if (!result) {
      throw new CivicSinkError(
        `sink.save must return { inserted, skipped } as non-negative integers (it returned ${JSON.stringify(reply) ?? "undefined"} on ${where})`,
        { saved: progress(), unsaved: prepared.records.length - sent, batch: i + 1, batches }
      );
    }
    sent += batch.length;
    total.inserted += result.inserted;
    total.skipped += result.skipped;
    if (result.updated !== undefined) {
      total.updated += result.updated;
      total.sawUpdated = true;
    }
    emit(ctx, {
      type: "sink.save",
      batch: i + 1,
      batches,
      records: batch.length,
      inserted: result.inserted,
      skipped: result.skipped,
      ...(result.updated !== undefined ? { updated: result.updated } : {}),
      duplicates: prepared.duplicates,
      durationMs: Date.now() - startedAt,
    });
  }
  return progress();
}

export interface SinkCheckResult {
  ok: boolean;
  failures: string[];
}

/**
 * Check a sink against the contract by saving a few clearly-marked test records
 * through it: new records are inserted, the same records again are not inserted
 * twice (skipped, or reported as `updated` by an upserting sink), a mixed batch
 * inserts only the new one, and every reply is a valid SaveResult. It writes
 * records whose keys start with "civic-sink-check:"; pass `cleanup` to delete
 * them. Run it in your own test suite against your real sink.
 */
export async function checkSinkContract(
  sink: CivicRecordSink,
  opts: { cleanup?: (keys: string[]) => void | Promise<void> } = {}
): Promise<SinkCheckResult> {
  const prefix = `civic-sink-check:${randomUUID()}:`;
  const make = (n: number): CivicRecord => ({
    provider: "socrata",
    type: "police_blotter",
    title: `Sink check ${n}`,
    date: "2026-01-01",
    dedupeKey: `${prefix}${n}`,
    localityName: "Sink Check",
    sourceId: "sink-check",
  });
  const [a, b, c, d] = [make(1), make(2), make(3), make(4)] as [CivicRecord, CivicRecord, CivicRecord, CivicRecord];
  const failures: string[] = [];

  const call = async (what: string, batch: CivicRecord[]): Promise<SaveResult | null> => {
    let reply: unknown;
    try {
      reply = await sink.save(batch);
    } catch (err) {
      failures.push(`save threw when ${what}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const result = readSaveResult(reply);
    if (!result) {
      failures.push(`save must return { inserted, skipped } as non-negative integers when ${what}; it returned ${JSON.stringify(reply) ?? "undefined"}`);
      return null;
    }
    return result;
  };

  try {
    const first = await call("saving 3 new records", [a, b, c]);
    if (first && first.inserted !== 3) failures.push(`saving 3 new records returned ${JSON.stringify(first)}; expected inserted: 3`);

    const again = await call("saving the same records again", [a, b, c]);
    if (again && (again.inserted !== 0 || again.skipped + (again.updated ?? 0) !== 3)) {
      failures.push(
        `saving the same records again must not insert them again: expected inserted 0 and skipped (or updated) 3, got ${JSON.stringify(again)}. Records are identified by dedupeKey and a repeat must be a no-op or an update.`
      );
    }

    const mixed = await call("saving 2 known records and 1 new one", [b, c, d]);
    if (mixed && mixed.inserted !== 1) failures.push(`saving 2 known records and 1 new one returned ${JSON.stringify(mixed)}; expected inserted: 1`);
  } finally {
    await opts.cleanup?.([a, b, c, d].map((r) => r.dedupeKey));
  }
  return { ok: failures.length === 0, failures };
}
