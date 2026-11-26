import { describe, it, expect, vi, beforeEach } from "vitest";
import { httpFetch, resetHttpState } from "./http.js";
import type { HttpPolicy } from "./types.js";

const ok = (body = "ok") => new Response(body);
const status = (code: number, headers: Record<string, string> = {}) => new Response(null, { status: code, headers });

/** A fetch that serves a queue of outcomes (Response or Error) and records each call. */
function queue(...outcomes: Array<Response | Error | (() => Response | Error)>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = outcomes.shift();
    if (next === undefined) throw new Error("fetch called more times than scripted");
    const out = typeof next === "function" ? next() : next;
    if (out instanceof Error) throw out;
    return out;
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls, fetchMock };
}

/** A fake clock: sleep() advances `now` and records the wait. */
function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const policy: HttpPolicy = {
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    random: () => 1, // full delay, so backoff is exact
  };
  return { policy, sleeps, now: () => t };
}

const baseCtx = (fetchImpl: typeof fetch, http?: HttpPolicy) => ({ fetch: fetchImpl, skipRobotsCheck: true, http });
const networkError = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

beforeEach(() => resetHttpState());

describe("httpFetch basics", () => {
  it("passes a success straight through with a user-agent, a deadline and the caller's init", async () => {
    const q = queue(ok("hi"));
    const res = await httpFetch({ ...baseCtx(q.fetch), userAgent: "ua/1" }, "https://a.example.gov/x", { method: "GET", headers: { Accept: "text/html" } });
    expect(await res.text()).toBe("hi");
    expect(q.calls[0]?.init?.headers).toMatchObject({ "User-Agent": "ua/1", Accept: "text/html" });
    expect(q.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(q.calls[0]?.init?.redirect).toBe("manual");
  });

  it("does not override a User-Agent the caller set", async () => {
    const q = queue(ok());
    await httpFetch(baseCtx(q.fetch), "https://a.example.gov/x", { headers: { "user-agent": "mine" } });
    const h = q.calls[0]?.init?.headers as Record<string, string>;
    expect(Object.values(h)).toContain("mine");
    expect(Object.keys(h).filter((k) => k.toLowerCase() === "user-agent")).toHaveLength(1);
  });

  it("still vets redirects (and never retries a policy refusal)", async () => {
    const c = clock();
    const q = queue(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    await expect(httpFetch(baseCtx(q.fetch, c.policy), "https://a.example.gov/x")).rejects.toThrow(/blocked host/);
    expect(q.calls).toHaveLength(1);
    expect(c.sleeps).toEqual([]);
  });
});

describe("retries", () => {
  it("retries 503 with exponential backoff, then returns the success", async () => {
    const c = clock();
    const q = queue(status(503), status(503), ok("fine"));
    const res = await httpFetch(baseCtx(q.fetch, { ...c.policy, baseDelayMs: 100 }), "https://a.example.gov/x");
    expect(await res.text()).toBe("fine");
    expect(q.calls).toHaveLength(3);
    expect(c.sleeps).toEqual([100, 200]);
  });

  it("retries 429, 502, 503 and 504, but not 400, 404 or 500", async () => {
    for (const code of [429, 502, 503, 504]) {
      resetHttpState();
      const q = queue(status(code), ok());
      await httpFetch(baseCtx(q.fetch, clock().policy), `https://r${code}.example.gov/`);
      expect(q.calls, `status ${code}`).toHaveLength(2);
    }
    for (const code of [400, 404, 500]) {
      const q = queue(status(code));
      const res = await httpFetch(baseCtx(q.fetch, clock().policy), `https://n${code}.example.gov/`);
      expect(res.status).toBe(code);
      expect(q.calls, `status ${code}`).toHaveLength(1);
    }
  });

  it("gives up after the retry budget and returns the last response, not an exception", async () => {
    const c = clock();
    const q = queue(status(503), status(503), status(503), status(503));
    const res = await httpFetch(baseCtx(q.fetch, c.policy), "https://a.example.gov/x");
    expect(res.status).toBe(503);
    expect(q.calls).toHaveLength(4); // 1 + 3 retries
  });

  it("caps the backoff at maxDelayMs", async () => {
    const c = clock();
    const q = queue(status(503), status(503), status(503), ok());
    await httpFetch(baseCtx(q.fetch, { ...c.policy, baseDelayMs: 1000, maxDelayMs: 1500 }), "https://a.example.gov/x");
    expect(c.sleeps).toEqual([1000, 1500, 1500]);
  });

  it("adds jitter: with random=0 the wait is half the backoff", async () => {
    const c = clock();
    const q = queue(status(503), ok());
    await httpFetch(baseCtx(q.fetch, { ...c.policy, random: () => 0, baseDelayMs: 100 }), "https://a.example.gov/x");
    expect(c.sleeps).toEqual([50]);
  });

  it("retries a network error and a timeout, and rethrows once the budget is spent", async () => {
    const c = clock();
    const q = queue(networkError(), timeoutError(), ok("recovered"));
    expect(await (await httpFetch(baseCtx(q.fetch, c.policy), "https://a.example.gov/x")).text()).toBe("recovered");
    const dead = queue(networkError(), networkError(), networkError(), networkError());
    await expect(httpFetch(baseCtx(dead.fetch, clock().policy), "https://b.example.gov/x")).rejects.toThrow(/fetch failed/);
    expect(dead.calls).toHaveLength(4);
  });

  it("does not retry errors that are not network trouble", async () => {
    const q = queue(new Error("boom"));
    await expect(httpFetch(baseCtx(q.fetch, clock().policy), "https://a.example.gov/x")).rejects.toThrow("boom");
    expect(q.calls).toHaveLength(1);
    await expect(httpFetch(baseCtx(queue().fetch, clock().policy), "not a url")).rejects.toThrow();
  });

  it("can be switched off", async () => {
    const q = queue(status(503));
    const res = await httpFetch(baseCtx(q.fetch, { retries: 0 }), "https://a.example.gov/x");
    expect(res.status).toBe(503);
    expect(q.calls).toHaveLength(1);
  });

  it("releases the body of a response it is about to retry", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() {}, cancel });
    const q = queue(new Response(body, { status: 503 }), ok());
    await httpFetch(baseCtx(q.fetch, clock().policy), "https://a.example.gov/x");
    expect(cancel).toHaveBeenCalled();
  });

  it("does not retry a POST unless the caller says it is safe to repeat", async () => {
    const plain = queue(status(503));
    expect((await httpFetch(baseCtx(plain.fetch, clock().policy), "https://a.example.gov/x", { method: "POST", body: "{}" })).status).toBe(503);
    expect(plain.calls).toHaveLength(1);
    const safe = queue(status(503), ok());
    await httpFetch(baseCtx(safe.fetch, clock().policy), "https://b.example.gov/x", { method: "POST", body: "{}" }, { idempotent: true });
    expect(safe.calls).toHaveLength(2);
  });
});

describe("Retry-After", () => {
  it("waits exactly as long as the server says (seconds)", async () => {
    const c = clock();
    const q = queue(status(429, { "retry-after": "3" }), ok());
    await httpFetch(baseCtx(q.fetch, c.policy), "https://a.example.gov/x");
    expect(c.sleeps).toEqual([3000]);
  });

  it("understands an HTTP date", async () => {
    const c = clock();
    const when = new Date(c.now() + 4000).toUTCString();
    const q = queue(status(503, { "retry-after": when }), ok());
    await httpFetch(baseCtx(q.fetch, c.policy), "https://a.example.gov/x");
    expect(c.sleeps[0]).toBeGreaterThanOrEqual(3000);
    expect(c.sleeps[0]).toBeLessThanOrEqual(4000);
  });

  it("does not sleep for an hour: a Retry-After beyond maxDelayMs returns the response at once", async () => {
    const c = clock();
    const q = queue(status(429, { "retry-after": "3600" }));
    const res = await httpFetch(baseCtx(q.fetch, { ...c.policy, maxDelayMs: 30_000 }), "https://a.example.gov/x");
    expect(res.status).toBe(429);
    expect(q.calls).toHaveLength(1);
    expect(c.sleeps).toEqual([]);
  });

  it("falls back to backoff for a garbage Retry-After", async () => {
    const c = clock();
    const q = queue(status(429, { "retry-after": "soon" }), ok());
    await httpFetch(baseCtx(q.fetch, { ...c.policy, baseDelayMs: 100 }), "https://a.example.gov/x");
    expect(c.sleeps).toEqual([100]);
  });
});

describe("a 429 slows every request to that host, not just the one that got it", () => {
  /** A clock whose sleeps stay pending until the test moves time forward. */
  function manualClock() {
    let t = 1_000_000;
    const timers: Array<{ at: number; resolve: () => void }> = [];
    const policy: HttpPolicy = {
      now: () => t,
      random: () => 1,
      sleep: (ms) => new Promise<void>((resolve) => timers.push({ at: t + ms, resolve })),
    };
    const advance = (ms: number) => {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers.splice(0, timers.length, ...timers.filter((x) => x.at > t));
      for (const x of due) x.resolve();
    };
    return { policy, advance };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("holds a second request until the host's Retry-After has passed", async () => {
    const c = manualClock();
    const urls: string[] = [];
    let first = true;
    const fetchImpl = (async (input: unknown) => {
      urls.push(String(input));
      if (first) {
        first = false;
        return status(429, { "retry-after": "2" });
      }
      return ok();
    }) as unknown as typeof fetch;
    const ctx = baseCtx(fetchImpl, c.policy);

    const a = httpFetch(ctx, "https://shared.example.gov/a");
    await flush(); // A is sent, told to wait 2 s, and is now waiting
    const b = httpFetch(ctx, "https://shared.example.gov/b");
    await flush(); // B must NOT have been sent: the gate is closed
    expect(urls).toEqual(["https://shared.example.gov/a"]);

    c.advance(2000);
    await Promise.all([a, b]);
    expect(urls.sort()).toEqual(["https://shared.example.gov/a", "https://shared.example.gov/a", "https://shared.example.gov/b"]);
  });

  it("does not slow a different host", async () => {
    const c = manualClock();
    const urls: string[] = [];
    let first = true;
    const fetchImpl = (async (input: unknown) => {
      urls.push(String(input));
      if (first) {
        first = false;
        return status(429, { "retry-after": "5" });
      }
      return ok();
    }) as unknown as typeof fetch;
    const ctx = baseCtx(fetchImpl, c.policy);
    const slow = httpFetch(ctx, "https://slow.example.gov/a");
    await flush();
    await httpFetch(ctx, "https://other.example.gov/a"); // completes with no time passing
    expect(urls).toContain("https://other.example.gov/a");
    c.advance(5000);
    await slow;
  });
});
