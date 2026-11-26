// Structured events and per-run counters. A run's identity and counters travel
// in an AsyncLocalStorage, so the HTTP layer, the retry loop and every parallel
// worker report to the right run without any signature carrying a handle.
// Not exported from the package entry point.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AdapterResult,
  CivicEvent,
  CivicEventPayload,
  CivicLogger,
  CivicSource,
  Locality,
  RunStats,
} from "./types.js";

interface RunTelemetry {
  runId: string;
  provider: string;
  locality: string;
  sourceId: string | number;
  started: number;
  requests: number;
  retries: number;
  llmCalls: number;
}

const store = new AsyncLocalStorage<RunTelemetry>();

/** Remove query strings from any URL in a message: they can carry API keys. */
export function scrub(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#"')]+)\?[^\s#"')]*/g, "$1");
}

type Sink = { onEvent?: (event: CivicEvent) => void | Promise<void>; logger?: CivicLogger };

/** Deliver an event to `ctx.onEvent`, tagged with the current run. Never throws. */
export function emit(ctx: Pick<Sink, "onEvent">, payload: CivicEventPayload): void {
  const handler = ctx.onEvent;
  if (!handler) return;
  const run = store.getStore();
  const event = {
    ts: Date.now(),
    ...(run ? { runId: run.runId, provider: run.provider, locality: run.locality, sourceId: run.sourceId } : {}),
    ...payload,
  } as CivicEvent;
  try {
    const out = handler(event);
    if (out && typeof (out as Promise<void>).catch === "function") (out as Promise<void>).catch(() => undefined);
  } catch {
    // telemetry must never break a run
  }
}

/** Count one HTTP attempt (and whether it was a retry) against the current run, if any. */
export function countRequest(isRetry: boolean): void {
  const run = store.getStore();
  if (!run) return;
  run.requests++;
  if (isRetry) run.retries++;
}

/** How many LLM calls the current run has made so far (0 outside a run). */
export function llmCallsSoFar(): number {
  return store.getStore()?.llmCalls ?? 0;
}

/** Count one call to the `summarize` callback against the current run, if any. */
export function countLlmCall(): void {
  const run = store.getStore();
  if (run) run.llmCalls++;
}

/**
 * Run `fn` as one observed run: emit run.start and run.end, count its work,
 * and put the counters on the result. Re-entrant: inside an observed run it
 * just calls `fn`, so runAdapter and a direct adapter call both work.
 */
export async function observed(
  ctx: Pick<AdapterContext, "onEvent">,
  info: { provider: string; locality: Locality; source: CivicSource },
  fn: () => Promise<AdapterResult>
): Promise<AdapterResult> {
  if (store.getStore()) return fn();
  const run: RunTelemetry = {
    runId: randomUUID(),
    provider: info.provider,
    locality: info.locality.name,
    sourceId: info.source.id,
    started: Date.now(),
    requests: 0,
    retries: 0,
    llmCalls: 0,
  };
  return store.run(run, async () => {
    emit(ctx, { type: "run.start" });
    try {
      const result = await fn();
      const stats: RunStats = {
        durationMs: Date.now() - run.started,
        requests: run.requests,
        retries: run.retries,
        llmCalls: run.llmCalls,
      };
      emit(ctx, {
        type: "run.end",
        status: result.status,
        inserted: result.inserted,
        skipped: result.skipped,
        problems: result.problems.length,
        stats,
      });
      return { ...result, stats };
    } catch (err) {
      emit(ctx, { type: "run.error", message: scrub(err instanceof Error ? err.message : String(err)) });
      throw err;
    }
  });
}
