import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAdapter } from "./registry.js";
import { discoverBlotter } from "./discovery/blotter.js";
import { resetHttpState } from "./http.js";
import { MemorySink } from "./types.js";
import type { AdapterContext, CivicEvent, LlmCallInfo, Locality } from "./types.js";

const locality: Locality = { name: "Exampleville", state: "PA" };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ EventItemId: i + 1, EventItemTitle: `Approve the contract number ${i + 1} for street paving` }));
const EVENT = { EventId: 1, EventDate: "2026-03-04T00:00:00", EventBodyName: "Council" };

function legistarCtx(summarize: AdapterContext["summarize"], extra: Partial<AdapterContext> = {}, n = 3) {
  const events: CivicEvent[] = [];
  const ctx: AdapterContext = {
    sink: new MemorySink(),
    skipRobotsCheck: true,
    http: { sleep: async () => {} },
    summarize,
    onEvent: (e) => void events.push(e),
    fetch: (async (input: unknown) => (String(input).includes("/EventItems") ? json(items(n)) : json([EVENT]))) as unknown as typeof fetch,
    ...extra,
  };
  return { ctx, events, sink: ctx.sink as MemorySink };
}
const legistar = { provider: "legistar", clientId: "llm-test", since: "2026-01-01", concurrency: 1 } as const;
const llmEvents = (events: CivicEvent[]) => events.filter((e): e is Extract<CivicEvent, { type: "llm.call" }> => e.type === "llm.call");

beforeEach(() => resetHttpState());

describe("what the callback is told", () => {
  it("gets the purpose and an abort signal as a third argument", async () => {
    const calls: Array<{ system: string; text: string; info: LlmCallInfo | undefined }> = [];
    const { ctx } = legistarCtx(async (system, text, info) => {
      calls.push({ system, text, info });
      return "A summary.";
    }, {}, 1);
    await runAdapter(locality, { id: 1 }, legistar, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.info?.purpose).toBe("summarize_agenda_item");
    expect(calls[0]?.info?.signal).toBeInstanceOf(AbortSignal);
  });

  it("labels html_minutes extraction and discovery proposals", async () => {
    const purposes: string[] = [];
    const record = async (_s: string, _t: string, info?: LlmCallInfo) => {
      purposes.push(info?.purpose ?? "none");
      return "[]";
    };
    await runAdapter(locality, { id: 1 }, { provider: "html_minutes", url: "https://m.example.gov/m" }, {
      sink: new MemorySink(),
      skipRobotsCheck: true,
      summarize: record,
      fetch: (async () => new Response("<p>Council met and adjourned after a long discussion of several matters.</p>")) as unknown as typeof fetch,
    });
    await discoverBlotter(locality, { generate: record, fetch: (async () => new Response("")) as unknown as typeof fetch, skipRobotsCheck: true });
    expect(purposes).toEqual(["extract_minutes", "propose_blotter"]);
  });

  it("still works with a plain two-argument callback", async () => {
    const { ctx, sink } = legistarCtx(async (_system, text) => `S: ${text.slice(0, 7)}`, {}, 1);
    expect(await runAdapter(locality, { id: 1 }, legistar, ctx)).toMatchObject({ status: "ok", inserted: 1 });
    expect([...sink.records.values()][0]?.summary).toBe("S: Approve");
  });

  it("tells the model the document is untrusted and its instructions are not to be followed", async () => {
    const systems: string[] = [];
    const { ctx } = legistarCtx(async (system) => {
      systems.push(system);
      return "ok";
    }, {}, 1);
    await runAdapter(locality, { id: 1 }, legistar, ctx);
    await runAdapter(locality, { id: 2 }, { provider: "html_minutes", url: "https://m.example.gov/m" }, {
      sink: new MemorySink(),
      skipRobotsCheck: true,
      summarize: async (system) => {
        systems.push(system);
        return "[]";
      },
      fetch: (async () => new Response("<p>Council met and adjourned after a long discussion of several matters.</p>")) as unknown as typeof fetch,
    });
    expect(systems.length).toBeGreaterThanOrEqual(2);
    for (const s of systems) expect(s).toMatch(/untrusted/i);
    for (const s of systems) expect(s).toMatch(/never follow|do not follow/i);
  });
});

describe("what comes back", () => {
  it("accepts { text, usage } and reports the tokens in the llm.call event", async () => {
    const { ctx, events, sink } = legistarCtx(async () => ({ text: "Council approved paving.", usage: { inputTokens: 120, outputTokens: 8 } }), {}, 1);
    await runAdapter(locality, { id: 1 }, legistar, ctx);
    expect([...sink.records.values()][0]?.summary).toBe("Council approved paving.");
    expect(llmEvents(events)[0]).toMatchObject({ purpose: "summarize_agenda_item", ok: true, inputTokens: 120, outputTokens: 8 });
  });

  it("treats a reply that is not text as a failed call, and falls back to the title", async () => {
    for (const bad of [undefined, 42, { nope: 1 }, null]) {
      const { ctx, events, sink } = legistarCtx((async () => bad) as never, {}, 1);
      const r = await runAdapter(locality, { id: 1 }, legistar, ctx);
      expect(r.status).toBe("partial");
      expect(llmEvents(events)[0]).toMatchObject({ ok: false });
      expect(llmEvents(events)[0]?.error).toMatch(/string/);
      expect([...sink.records.values()][0]?.summary).toBe("Approve the contract number 1 for street paving");
    }
  });

  it("strips control and direction-override characters, so a page cannot smuggle them into a summary", async () => {
    const { ctx, sink } = legistarCtx(async () => "Approved\u0000 the ‮contract‬​ now\u0007.", {}, 1);
    await runAdapter(locality, { id: 1 }, legistar, ctx);
    expect([...sink.records.values()][0]?.summary).toBe("Approved the contract now.");
  });

  it("caps a runaway summary, cutting at a sentence end when it can", async () => {
    const long = "This is one sentence. ".repeat(200);
    const { ctx, sink } = legistarCtx(async () => long, {}, 1);
    await runAdapter(locality, { id: 1 }, legistar, ctx);
    const summary = [...sink.records.values()][0]?.summary ?? "";
    expect(summary.length).toBeLessThanOrEqual(1500);
    expect(summary.endsWith(".")).toBe(true);
  });

  it("falls back to the title when the model returns only whitespace or junk characters", async () => {
    const { ctx, sink } = legistarCtx(async () => "  ​\u0000 \n ", {}, 1);
    await runAdapter(locality, { id: 1 }, legistar, ctx);
    expect([...sink.records.values()][0]?.summary).toBe("Approve the contract number 1 for street paving");
  });
});

describe("deadlines and budgets", () => {
  it("gives up on a callback that never answers, aborts its signal, and carries on", async () => {
    let signal: AbortSignal | undefined;
    const { ctx, events, sink } = legistarCtx(
      (_s, _t, info) =>
        new Promise<string>(() => {
          signal = info?.signal;
        }),
      { llm: { timeoutMs: 40 } },
      1
    );
    const r = await runAdapter(locality, { id: 1 }, legistar, ctx);
    expect(r.status).toBe("partial");
    expect(signal?.aborted).toBe(true);
    expect(llmEvents(events)[0]).toMatchObject({ ok: false });
    expect(llmEvents(events)[0]?.error).toMatch(/timed out after 40 ms/);
    expect([...sink.records.values()][0]?.summary).toBe("Approve the contract number 1 for street paving");
  });

  it("stops calling the model after maxCalls and says so, using title text for the rest", async () => {
    const summarize = vi.fn(async () => "A summary.");
    const { ctx, events, sink } = legistarCtx(summarize, { llm: { maxCalls: 2 } }, 5);
    const r = await runAdapter(locality, { id: 1 }, legistar, ctx);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(r.stats.llmCalls).toBe(2);
    expect(r.status).toBe("partial");
    expect(r.problems.join()).toMatch(/LLM call budget \(2\) exhausted/);
    const summaries = [...sink.records.values()].map((x) => x.summary);
    expect(summaries.filter((s) => s === "A summary.")).toHaveLength(2);
    expect(summaries.filter((s) => s?.startsWith("Approve the contract"))).toHaveLength(3);
    expect(llmEvents(events).filter((e) => !e.ok)).toHaveLength(3);
    expect(llmEvents(events).filter((e) => !e.ok)[0]?.error).toMatch(/budget/);
  });

  it("has a default budget so a huge agenda cannot run up an unbounded bill", async () => {
    const summarize = vi.fn(async () => "S.");
    const { ctx } = legistarCtx(summarize, {}, 1200);
    const r = await runAdapter(locality, { id: 1 }, legistar, ctx);
    expect(summarize).toHaveBeenCalledTimes(1000);
    expect(r.problems.join()).toMatch(/LLM call budget \(1000\) exhausted/);
  });

  it("lets you lift the budget", async () => {
    const summarize = vi.fn(async () => "S.");
    const { ctx } = legistarCtx(summarize, { llm: { maxCalls: Infinity } }, 1100);
    await runAdapter(locality, { id: 1 }, legistar, ctx);
    expect(summarize).toHaveBeenCalledTimes(1100);
  });

  it("the budget is per run, not per process", async () => {
    const summarize = vi.fn(async () => "S.");
    const { ctx } = legistarCtx(summarize, { llm: { maxCalls: 3 } }, 3);
    await runAdapter(locality, { id: 1 }, legistar, ctx);
    await runAdapter(locality, { id: 2 }, legistar, ctx);
    expect(summarize).toHaveBeenCalledTimes(6);
  });

  it("html_minutes counts a refused section as a failed section", async () => {
    const para = (n: number) => `Motion ${n} to approve contract number ${n} for street paving on the north side of town passed 5-2 after discussion.`;
    const page = `<p>${Array.from({ length: 300 }, (_, i) => para(i + 1)).join(" ")}</p>`;
    const { ctx } = legistarCtx(async () => "[]", { llm: { maxCalls: 1 }, fetch: (async () => new Response(page)) as unknown as typeof fetch });
    const r = await runAdapter(locality, { id: 1 }, { provider: "html_minutes", url: "https://m.example.gov/m" }, ctx);
    expect(r.stats.llmCalls).toBe(1);
    expect(r.problems.join()).toMatch(/section\(s\) failed/);
  });

  it("discovery gives up on a model that never answers, instead of hanging", async () => {
    await expect(
      discoverBlotter(locality, { generate: () => new Promise<string>(() => {}), llm: { timeoutMs: 30 }, skipRobotsCheck: true })
    ).rejects.toThrow(/timed out after 30 ms/);
  });
});

describe("llm.call events", () => {
  it("carry purpose, timing and sizes, never the text", async () => {
    const { ctx, events } = legistarCtx(async () => "Council approved the paving contract.", {}, 1);
    const r = await runAdapter(locality, { id: 1 }, legistar, ctx);
    const e = llmEvents(events)[0];
    expect(e).toMatchObject({ purpose: "summarize_agenda_item", ok: true, outputChars: "Council approved the paving contract.".length });
    expect(e?.inputChars).toBeGreaterThan(0);
    expect(e?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain("paving contract");
    expect(r.stats.llmCalls).toBe(1);
  });

  it("strip a query string from an error message", async () => {
    const { ctx, events } = legistarCtx(async () => {
      throw new Error("upstream said no: https://gateway.example.com/v1?key=SECRET-KEY");
    }, {}, 1);
    await runAdapter(locality, { id: 1 }, legistar, ctx);
    expect(JSON.stringify(events)).not.toContain("SECRET-KEY");
  });
});
