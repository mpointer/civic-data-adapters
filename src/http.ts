// The one place outbound requests are made: a per-attempt deadline, the
// User-Agent, redirect vetting (see safeFetch) and retry with backoff.
// A 429 or 503 from a public API is routine; before this layer every adapter
// treated it as a dead source. Not exported from the package entry point.
import type { AdapterContext, HttpPolicy } from "./types.js";
import { FETCH_TIMEOUT_MS, ctxUserAgent, safeFetch, type SafeFetchOptions } from "./internal.js";
import { countRequest, emit, scrub } from "./telemetry.js";

export type HttpCtx = Pick<
  AdapterContext,
  "fetch" | "userAgent" | "skipRobotsCheck" | "robotsCheck" | "http" | "logger" | "onEvent"
>;

export interface HttpOptions extends SafeFetchOptions {
  /** Per-attempt deadline. Default FETCH_TIMEOUT_MS (30 s). */
  timeoutMs?: number;
  /** Override the policy's retry count for this call (0 = no retries). */
  retries?: number;
  /** The request is safe to repeat even though its method is not GET/HEAD (e.g. a read-only POST search). */
  idempotent?: boolean;
}

const DEFAULTS = { retries: 3, baseDelayMs: 500, maxDelayMs: 30_000 };
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** When a host last said "slow down", so every request to it waits, not just the one that was told. */
const hostGate = new Map<string, number>();

/** Forget which hosts asked us to slow down. For tests. */
export function resetHttpState(): void {
  hostGate.clear();
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function headersWithUserAgent(headers: RequestInit["headers"], ua: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) headers.forEach((v, k) => (out[k] = v));
  else if (Array.isArray(headers)) for (const [k, v] of headers) out[k as string] = v as string;
  else if (headers) Object.assign(out, headers);
  if (!Object.keys(out).some((k) => k.toLowerCase() === "user-agent")) out["User-Agent"] = ua;
  return out;
}

/** Network trouble worth another try: a timeout, or fetch's own "fetch failed" (a TypeError), but not a bad URL. */
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  return err instanceof TypeError && (err as NodeJS.ErrnoException).code !== "ERR_INVALID_URL";
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; undefined when absent or unreadable. */
function retryAfterMs(res: Response, now: number): number | undefined {
  const raw = res.headers?.get?.("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * `fetch` with a deadline, a User-Agent, vetted redirects and retries.
 *
 * Retries on 429, 502, 503 and 504 and on network errors and timeouts, up to
 * `retries` times (default 3) with exponential backoff and jitter, honoring
 * `Retry-After`. A `Retry-After` longer than `maxDelayMs` is not waited out:
 * the response is returned so the caller fails fast instead of sleeping an hour.
 * A 429 also holds back every other request to that host until it passes.
 * After the budget is spent the last response is returned (callers already
 * handle `!res.ok`) or the last network error is thrown. Only GET and HEAD, or
 * requests marked `idempotent`, are repeated. Policy refusals from safeFetch
 * (blocked host, robots.txt, too many redirects) are never retried.
 *
 * Retry covers the request and its headers, not reading the body afterwards.
 */
export async function httpFetch(
  ctx: HttpCtx,
  url: string,
  init: RequestInit = {},
  opts: HttpOptions = {}
): Promise<Response> {
  const policy = ctx.http ?? {};
  const retries = Math.max(0, Math.floor(opts.retries ?? policy.retries ?? DEFAULTS.retries));
  const baseDelayMs = policy.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = policy.sleep ?? defaultSleep;
  const now = policy.now ?? Date.now;
  const random = policy.random ?? Math.random;

  const method = (init.method ?? "GET").toUpperCase();
  const repeatable = method === "GET" || method === "HEAD" || opts.idempotent === true;
  const maxRetries = repeatable ? retries : 0;

  // Host and path only: a query string can carry an API key.
  const { host, path } = (() => {
    try {
      const u = new URL(url);
      return { host: u.hostname, path: u.pathname };
    } catch {
      return { host: "(invalid url)", path: "" };
    }
  })();
  const headers = headersWithUserAgent(init.headers, ctxUserAgent(ctx));
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  // Full backoff for this attempt, with jitter in the upper half so concurrent
  // workers do not retry in lockstep.
  const backoff = (attempt: number) => {
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
  };
  const note = (reason: string, ms: number, attempt: number) => {
    emit(ctx, { type: "http.retry", host, reason, waitMs: ms, attempt: attempt + 1 });
    return ctx.logger?.log(`http: ${host} ${reason}; retrying in ${ms} ms (${attempt + 1}/${maxRetries})`, "info");
  };

  for (let attempt = 0; ; attempt++) {
    const closedFor = (hostGate.get(host) ?? 0) - now();
    if (closedFor > 0) await sleep(closedFor);

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    countRequest(attempt > 0);
    const startedAt = now();
    try {
      res = await safeFetch(ctx, url, { ...init, headers, signal }, opts);
    } catch (err) {
      emit(ctx, {
        type: "http.attempt",
        host,
        method,
        path,
        error: scrub(err instanceof Error ? err.message : String(err)),
        durationMs: now() - startedAt,
        attempt: attempt + 1,
      });
      if (attempt >= maxRetries || !isTransient(err)) throw err;
      const wait = backoff(attempt);
      await note((err as Error).name === "TimeoutError" ? "timed out" : "network error", wait, attempt);
      await sleep(wait);
      continue;
    }

    emit(ctx, { type: "http.attempt", host, method, path, status: res.status, durationMs: now() - startedAt, attempt: attempt + 1 });
    if (!RETRY_STATUSES.has(res.status) || attempt >= maxRetries) return res;

    const told = retryAfterMs(res, now());
    const wait = told ?? backoff(attempt);
    if (wait > maxDelayMs) return res; // asked to wait longer than we will: fail fast
    await res.body?.cancel().catch(() => undefined);
    await note(`HTTP ${res.status}`, wait, attempt);
    if (res.status === 429) {
      // Close the gate for the whole host; the top of the loop does the waiting.
      hostGate.set(host, Math.max(hostGate.get(host) ?? 0, now() + wait));
    } else {
      await sleep(wait);
    }
  }
}
