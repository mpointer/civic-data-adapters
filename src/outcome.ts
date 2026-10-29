// How an adapter run reports what happened. Callers used to get
// `{ inserted: 0, skipped: 0 }` for a dead URL, a robots.txt refusal, a bad
// config and a quiet day alike; `status` and `problems` tell them apart.
import type { AdapterContext, AdapterResult } from "./types.js";

export interface Run {
  /** Problems recorded so far (also logged as warnings). */
  readonly problems: string[];
  /** Record a problem and log it. The run continues. */
  problem(message: string): Promise<void>;
  /** Stop with nothing saved because the data could not be obtained. */
  fail(message: string): Promise<AdapterResult>;
  /** Stop with nothing saved because policy or the stub says not to run. */
  skip(message: string): Promise<AdapterResult>;
  /**
   * Finish after `ctx.sink.save`. `found` is how many records the adapter
   * handed to the sink. No problems: "ok" (even when empty: a quiet day is not
   * a failure). Problems and some records: "partial". Problems and no records:
   * "failed".
   */
  done(saved: { inserted: number; skipped: number }, found: number): AdapterResult;
}

/** `prefix` is what logged messages start with, e.g. `[Pittsburgh] socrata:`. */
export function createRun(ctx: Pick<AdapterContext, "logger">, prefix: string): Run {
  const problems: string[] = [];
  const problem = async (message: string) => {
    problems.push(message);
    await ctx.logger?.log(`${prefix} ${message}`, "warn");
  };
  return {
    problems,
    problem,
    async fail(message) {
      await problem(message);
      return { inserted: 0, skipped: 0, status: "failed", problems: [...problems] };
    },
    async skip(message) {
      await ctx.logger?.log(`${prefix} ${message}`, "warn");
      return { inserted: 0, skipped: 0, status: "skipped", problems: [...problems] };
    },
    done(saved, found) {
      const status = problems.length === 0 ? "ok" : found > 0 ? "partial" : "failed";
      return { inserted: saved.inserted, skipped: saved.skipped, status, problems: [...problems] };
    },
  };
}
