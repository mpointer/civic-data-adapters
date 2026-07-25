import { describe, it, expect } from "vitest";
import { parseCandidateJson } from "./candidates.js";

describe("parseCandidateJson tolerant extraction", () => {
  it("parses a bare JSON array", () => {
    const out = parseCandidateJson('[{"url":"https://a.example/blotter"}]', "url");
    expect(out).toEqual([{ url: "https://a.example/blotter" }]);
  });

  it("parses a markdown-fenced JSON array", () => {
    const raw = '```json\n[{"url":"https://a.example/1"},{"url":"https://a.example/2"}]\n```';
    expect(parseCandidateJson(raw, "url").map((c) => c.url)).toEqual([
      "https://a.example/1",
      "https://a.example/2",
    ]);
  });

  it("recovers an array wrapped in prose junk", () => {
    const raw = 'Here are the candidates I found:\n[{"clientId":"exampleville"}]\nHope that helps!';
    expect(parseCandidateJson(raw, "clientId")).toEqual([{ clientId: "exampleville" }]);
  });

  it("drops entries whose key is missing, non-string, or empty", () => {
    const raw = '[{"url":"https://ok.example"},{"url":42},{"nope":true},{"url":"  "}]';
    expect(parseCandidateJson(raw, "url")).toEqual([{ url: "https://ok.example" }]);
  });

  it("returns [] for garbage", () => {
    expect(parseCandidateJson("I could not find any blotters, sorry.", "url")).toEqual([]);
    expect(parseCandidateJson("", "url")).toEqual([]);
    expect(parseCandidateJson('{"url":"not an array"}', "url")).toEqual([]);
  });
});
