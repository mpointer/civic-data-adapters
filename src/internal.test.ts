import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_USER_AGENT } from "./internal.js";

// The default User-Agent carries the package version so site operators can
// tell which release is crawling them. It is a hand-written constant, so this
// fails (and release.yml, which runs vitest before publishing, stops) if a
// version bump forgets it — it had silently stayed at 0.1 through 0.4.0.
describe("DEFAULT_USER_AGENT", () => {
  it("matches the package.json version", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(DEFAULT_USER_AGENT).toContain(`civic-data-adapters/${version} `);
  });
});
