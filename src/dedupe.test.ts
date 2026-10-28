import { describe, it, expect } from "vitest";
import { contentKey } from "./dedupe.js";
import { runAdapter, MemorySink, extractIncidents } from "./index.js";
import { pdfIncidentRecords } from "./adapters/blotter-pdf.js";
import type { AdapterContext } from "./types.js";

describe("contentKey", () => {
  it("is stable for the same content and differs when any part differs", () => {
    const a = contentKey(["2026-03-04", "Theft", "100 Main St", ""], new Map());
    expect(contentKey(["2026-03-04", "Theft", "100 Main St", ""], new Map())).toBe(a);
    expect(contentKey(["2026-03-05", "Theft", "100 Main St", ""], new Map())).not.toBe(a);
    expect(contentKey(["2026-03-04", "Theft", "101 Main St", ""], new Map())).not.toBe(a);
  });

  it("does not confuse field boundaries", () => {
    expect(contentKey(["ab", "c"], new Map())).not.toBe(contentKey(["a", "bc"], new Map()));
  });

  it("ignores whitespace reflow and null vs empty", () => {
    expect(contentKey(["Theft  of\n bike", null], new Map())).toBe(contentKey(["Theft of bike", ""], new Map()));
  });

  it("keeps genuinely repeated rows distinct with an occurrence counter", () => {
    const seen = new Map<string, number>();
    const first = contentKey(["x"], seen);
    const second = contentKey(["x"], seen);
    expect(first).not.toBe(second);
    expect(first.endsWith(":1")).toBe(true);
    expect(second.endsWith(":2")).toBe(true);
  });
});

describe("blotter_html: rows without case numbers survive the page being updated", () => {
  const page = (rows: Array<[string, string, string]>) =>
    "<table><tr><th>Date</th><th>Offense</th><th>Location</th></tr>" +
    rows.map(([d, o, l]) => `<tr><td>${d}</td><td>${o}</td><td>${l}</td></tr>`).join("") +
    "</table>";
  const day1: Array<[string, string, string]> = [
    ["03/04/2026", "Theft", "100 Main St"],
    ["03/04/2026", "Noise", "200 Oak Ave"],
    ["03/03/2026", "DUI", "Route 8"],
  ];
  const meta = { provider: "blotter_html", url: "https://pd.example.gov/blotter" } as const;
  const make = () => {
    const sink = new MemorySink();
    let html = "";
    const ctx: AdapterContext = { sink, skipRobotsCheck: true, fetch: (async () => new Response(html)) as unknown as typeof fetch };
    const run = (rows: Array<[string, string, string]>) => {
      html = page(rows);
      return runAdapter({ name: "Town" }, { id: 1 }, meta, ctx);
    };
    return { sink, run };
  };

  it("inserts only the new incident when one is added at the top (the newest-first case)", async () => {
    const { sink, run } = make();
    expect(await run(day1)).toEqual({ inserted: 3, skipped: 0 });
    const day2 = await run([["03/05/2026", "Burglary", "9 Elm St"], ...day1]);
    expect(day2).toEqual({ inserted: 1, skipped: 3 });
    expect(sink.records.size).toBe(4);
  });

  it("is unaffected by the order of rows", async () => {
    const { run } = make();
    await run(day1);
    expect(await run([...day1].reverse())).toEqual({ inserted: 0, skipped: 3 });
  });

  it("keeps identical rows on one page as separate records, stably across runs", async () => {
    const { sink, run } = make();
    const dup = [day1[0]!, day1[0]!];
    expect(await run(dup)).toEqual({ inserted: 2, skipped: 0 });
    expect(await run(dup)).toEqual({ inserted: 0, skipped: 2 });
    expect(sink.records.size).toBe(2);
  });

  it("still keys rows that have a case number by locality and case number", async () => {
    const sink = new MemorySink();
    const html =
      "<table><tr><th>Date</th><th>Offense</th><th>Case #</th></tr><tr><td>03/04/2026</td><td>Theft</td><td>26-0001</td></tr></table>";
    await runAdapter({ name: "Town" }, { id: 1 }, meta, { sink, skipRobotsCheck: true, fetch: (async () => new Response(html)) as unknown as typeof fetch });
    expect([...sink.records.keys()]).toEqual(["blotter_html:Town:26-0001"]);
  });
});

describe("blotter_pdf: incidents survive the document being updated", () => {
  const text = (lines: string[]) => lines.join("\n");
  const base = ["03/04/2026 0912 Theft", "100 Main St", "03/03/2026 DUI", "Route 8"];
  const build = (pdfText: string, since?: string) =>
    pdfIncidentRecords(extractIncidents(pdfText), { url: "https://pd.example.gov/blotter.pdf", locality: { name: "Town" }, source: { id: 1 }, since });

  it("gives the same incident the same key when new incidents are prepended", () => {
    const before = build(text(base));
    const after = build(text(["03/05/2026 Burglary", "9 Elm St", ...base]));
    const beforeKeys = new Set(before.map((r) => r.dedupeKey));
    const fresh = after.filter((r) => !beforeKeys.has(r.dedupeKey));
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(3);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.title).toContain("Burglary");
  });

  it("is independent of the document's URL, so a rotating filename does not duplicate", () => {
    const a = build(text(base));
    const b = pdfIncidentRecords(extractIncidents(text(base)), { url: "https://pd.example.gov/2026-03-05.pdf", locality: { name: "Town" }, source: { id: 1 } });
    expect(b.map((r) => r.dedupeKey)).toEqual(a.map((r) => r.dedupeKey));
  });

  it("applies the since filter without changing the remaining keys", () => {
    const all = build(text(base));
    const recent = build(text(base), "2026-03-04");
    expect(recent).toHaveLength(1);
    expect(all.map((r) => r.dedupeKey)).toContain(recent[0]?.dedupeKey);
  });
});
