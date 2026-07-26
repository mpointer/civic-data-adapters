// BYO robotsCheck hook (issue #1, harvest:localnewsbuddy): consumers with
// their own robots implementation inject it instead of the bundled checker,
// eliminating the silent second robots.txt fetch NewsHound's adoption found.

import { describe, it, expect, vi } from "vitest";
import { robotsAllows } from "./internal.js";

describe("robotsAllows resolution order", () => {
  it("a provided robotsCheck runs INSTEAD of the bundled checker (no robots.txt fetch)", async () => {
    const fetchMock = vi.fn();
    const robotsCheck = vi.fn().mockResolvedValue(true);
    const allowed = await robotsAllows("https://example.gov/agenda", {
      fetch: fetchMock as unknown as typeof fetch,
      robotsCheck,
    });
    expect(allowed).toBe(true);
    expect(robotsCheck).toHaveBeenCalledWith("https://example.gov/agenda");
    expect(fetchMock).not.toHaveBeenCalled(); // the off-by-one from issue #1
  });

  it("a robotsCheck returning false blocks the request", async () => {
    const robotsCheck = vi.fn().mockResolvedValue(false);
    const allowed = await robotsAllows("https://example.gov/blocked", { robotsCheck });
    expect(allowed).toBe(false);
  });

  it("robotsCheck wins over skipRobotsCheck when both are set", async () => {
    const robotsCheck = vi.fn().mockResolvedValue(false);
    const allowed = await robotsAllows("https://example.gov/x", {
      skipRobotsCheck: true,
      robotsCheck,
    });
    expect(allowed).toBe(false);
    expect(robotsCheck).toHaveBeenCalledOnce();
  });

  it("skipRobotsCheck still short-circuits without a hook (no fetch)", async () => {
    const fetchMock = vi.fn();
    const allowed = await robotsAllows("https://example.gov/x", {
      fetch: fetchMock as unknown as typeof fetch,
      skipRobotsCheck: true,
    });
    expect(allowed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("default path still consults the bundled checker via ctx.fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "User-agent: *\nDisallow: /private",
    });
    const allowed = await robotsAllows("https://robots-hook-test.example/private/x", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(allowed).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
