import { describe, it, expect } from "vitest";
import { parseHtmlTables, htmlToText } from "./html.js";

describe("parseHtmlTables", () => {
  it("reads a plain table, header row included", () => {
    const html = `<table><tr><th>Date</th><th>Offense</th></tr><tr><td>03/01/2026</td><td>Theft</td></tr></table>`;
    expect(parseHtmlTables(html)).toEqual([[["Date", "Offense"], ["03/01/2026", "Theft"]]]);
  });

  it("strips inner tags, collapses whitespace, leaves entities alone", () => {
    const html = `<table><tr><td> <b>A &amp;\n  B</b> </td><td><a href="x">link</a></td></tr><tr><td>1</td><td>2</td></tr></table>`;
    expect(parseHtmlTables(html)[0]).toEqual([["A &amp; B", "link"], ["1", "2"]]);
  });

  it("handles omitted end tags the way browsers do", () => {
    const html = `<table><tr><td>a<td>b<tr><td>c<td>d</table>`;
    expect(parseHtmlTables(html)).toEqual([[["a", "b"], ["c", "d"]]]);
  });

  it("is case-insensitive and tolerates attributes", () => {
    const html = `<TABLE class="x"><TR id=1><TD colspan="2">a</TD></TR><TR><TD>b</TD></TR></TABLE>`;
    expect(parseHtmlTables(html)).toEqual([[["a"], ["b"]]]);
  });

  it("returns each table separately and skips single-row tables", () => {
    const html = `<table><tr><td>only</td></tr></table><table><tr><td>a</td></tr><tr><td>b</td></tr></table>`;
    expect(parseHtmlTables(html)).toEqual([[["a"], ["b"]]]);
  });

  it("keeps a nested table's cells out of the outer table", () => {
    const html = `<table><tr><td>outer1<table><tr><td>in1</td></tr><tr><td>in2</td></tr></table></td></tr><tr><td>outer2</td></tr></table>`;
    const tables = parseHtmlTables(html);
    expect(tables).toContainEqual([["in1"], ["in2"]]);
    expect(tables).toContainEqual([["outer1"], ["outer2"]]);
  });

  it("ignores tags inside comments", () => {
    const html = `<table><tr><td>a</td></tr><!-- <tr><td>hidden</td></tr> --><tr><td>b</td></tr></table>`;
    expect(parseHtmlTables(html)).toEqual([[["a"], ["b"]]]);
  });

  it("closes a table left open at the end of the document", () => {
    expect(parseHtmlTables(`<table><tr><td>a</td></tr><tr><td>b</td>`)).toEqual([[["a"], ["b"]]]);
  });

  it("does not mistake <thead>, <tbody> or <tr-like> names for rows and cells", () => {
    const html = `<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>`;
    expect(parseHtmlTables(html)).toEqual([[["h"], ["v"]]]);
  });

  it("returns nothing for text with no table", () => {
    expect(parseHtmlTables("<p>JS-rendered page</p>")).toEqual([]);
    expect(parseHtmlTables("")).toEqual([]);
  });
});

describe("htmlToText", () => {
  it("drops tags, scripts and styles and collapses whitespace", () => {
    const html = `<html><head><style>p{color:red}</style><script>var x = "<b>";</script></head><body><h1>Minutes</h1>\n<p>Motion   passed.</p></body></html>`;
    expect(htmlToText(html)).toBe("Minutes Motion passed.");
  });

  it("drops comments and handles upper-case script tags", () => {
    expect(htmlToText(`a<!-- <b>x</b> -->b<SCRIPT>1</SCRIPT>c`)).toBe("a b c");
  });

  it("keeps a lone < that does not start a tag", () => {
    expect(htmlToText("5 < 6 and 7 > 6")).toBe("5 < 6 and 7 > 6");
  });
});

describe("hostile input stays linear", () => {
  // Each of these took 0.2 to 0.45 s at 60-200 KB with the old regexes (quadratic), so
  // 800 KB took many seconds. Generous bound: this must not be flaky on a slow CI box.
  const timeIt = (fn: () => unknown) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };
  const MAX_MS = 750;

  it("unclosed <tr><td> repeated", () => {
    expect(timeIt(() => parseHtmlTables("<tr><td> x".repeat(80_000)))).toBeLessThan(MAX_MS);
  });
  it("unclosed nested <table> repeated", () => {
    expect(timeIt(() => parseHtmlTables("<table><tr><td>x".repeat(50_000)))).toBeLessThan(MAX_MS);
  });
  it("a table inside a table inside a table", () => {
    expect(timeIt(() => parseHtmlTables("<table><tr><td>".repeat(60_000) + "</table>".repeat(60_000)))).toBeLessThan(MAX_MS);
  });
  it("htmlToText on unclosed <script> and on a wall of <", () => {
    expect(timeIt(() => htmlToText("<script>x".repeat(100_000)))).toBeLessThan(MAX_MS);
    expect(timeIt(() => htmlToText("<".repeat(800_000)))).toBeLessThan(MAX_MS);
    expect(timeIt(() => htmlToText("<a ".repeat(300_000)))).toBeLessThan(MAX_MS);
    expect(timeIt(() => htmlToText("<!--".repeat(200_000)))).toBeLessThan(MAX_MS);
  });
});
