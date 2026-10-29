import { describe, it, expect } from "vitest";
import { mapLimit } from "./concurrency.js";

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("keeps results in input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(n);
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60, 70]);
    expect(peak).toBe(3);
  });

  it("runs serially at limit 1 and treats nonsense limits as 1", async () => {
    for (const limit of [1, 0, -4, NaN]) {
      let inFlight = 0;
      let peak = 0;
      await mapLimit([1, 2, 3], limit, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
      });
      expect(peak).toBe(1);
    }
  });

  it("handles an empty list and passes the index", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit(["a", "b"], 2, async (s, i) => `${s}${i}`)).toEqual(["a0", "b1"]);
  });

  it("rejects with the first error and starts no new work after it", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        await tick();
        if (n === 2) throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await tick(10);
    expect(started.length).toBeLessThan(6);
  });
});
