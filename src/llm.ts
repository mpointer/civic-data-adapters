// The one place the library calls your LLM: a purpose label, a deadline, a
// per-run call budget, a check on what comes back, and an event. The document
// text is untrusted (anyone can publish a page or a PDF), so the model's reply
// is treated as untrusted too: only text is accepted, control and
// direction-override characters are removed, and length is capped.
// Not exported from the package entry point.
import type { LlmCallback, LlmPolicy, LlmPurpose, LlmReply, CivicEventHandler } from "./types.js";
import { countLlmCall, emit, llmCallsSoFar, scrub } from "./telemetry.js";

const DEFAULT_MAX_CALLS = 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 100_000;

export class LlmBudgetError extends Error {
  constructor(readonly limit: number) {
    super(`LLM call budget (${limit}) exhausted`);
    this.name = "LlmBudgetError";
  }
}

// C0 controls except tab, newline and carriage return; DEL; zero-width and
// bidirectional-override characters, which can make text read differently from
// what it is; the BOM.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Strip unsafe characters and trim; cap at `max`, cutting at a sentence end when one is near. */
export function cleanLlmText(text: string, max: number): string {
  const clean = text.replace(UNSAFE, "").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.endsWith(".") ? cut.length - 1 : -1);
  return sentenceEnd >= max * 0.6 ? cut.slice(0, sentenceEnd + 1) : cut.trimEnd();
}

function readReply(reply: unknown): LlmReply {
  if (typeof reply === "string") return { text: reply };
  if (typeof reply === "object" && reply !== null && typeof (reply as LlmReply).text === "string") return reply as LlmReply;
  throw new Error("the LLM callback must return a string (or { text, usage })");
}

/**
 * Call `fn` for `purpose`. Refuses past the run's call budget (LlmBudgetError),
 * gives up after the deadline, aborts the callback's signal, validates and
 * cleans the reply, and reports an `llm.call` event either way. Throws on any
 * failure; callers fall back to their non-LLM path.
 */
export async function callLlm(
  ctx: { llm?: LlmPolicy; onEvent?: CivicEventHandler },
  purpose: LlmPurpose,
  fn: LlmCallback,
  systemPrompt: string,
  text: string,
  opts: { maxChars?: number } = {}
): Promise<string> {
  const maxCalls = ctx.llm?.maxCalls ?? DEFAULT_MAX_CALLS;
  const timeoutMs = ctx.llm?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inputChars = systemPrompt.length + text.length;
  const fail = (error: unknown, startedAt: number): never => {
    const message = scrub(error instanceof Error ? error.message : String(error));
    emit(ctx, { type: "llm.call", purpose, ok: false, durationMs: Date.now() - startedAt, inputChars, error: message });
    throw error;
  };

  if (llmCallsSoFar() >= maxCalls) return fail(new LlmBudgetError(maxCalls), Date.now());
  countLlmCall();

  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`LLM call timed out after ${timeoutMs} ms`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });

  let reply: LlmReply;
  try {
    const call = (async () => fn(systemPrompt, text, { purpose, signal: controller.signal }))();
    call.catch(() => undefined); // if the deadline wins, a late failure is not an unhandled rejection
    reply = readReply(await Promise.race([call, deadline]));
  } catch (err) {
    return fail(err, startedAt);
  } finally {
    clearTimeout(timer);
  }

  const out = cleanLlmText(reply.text, opts.maxChars ?? DEFAULT_MAX_CHARS);
  emit(ctx, {
    type: "llm.call",
    purpose,
    ok: true,
    durationMs: Date.now() - startedAt,
    inputChars,
    outputChars: out.length,
    ...(reply.usage?.inputTokens !== undefined ? { inputTokens: reply.usage.inputTokens } : {}),
    ...(reply.usage?.outputTokens !== undefined ? { outputTokens: reply.usage.outputTokens } : {}),
  });
  return out;
}
