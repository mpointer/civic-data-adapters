import { describe, it, expect } from "vitest";
import {
  parseLegistarEvents,
  parseLegistarEventItems,
  firstAttachmentUrl,
  parseUSASpendingPage,
  parsePropublicaPage,
} from "./responses.js";

describe("parseLegistarEvents", () => {
  const ev = { EventId: 5, EventDate: "2026-03-04T00:00:00", EventBodyName: "Council", EventLocation: "", EventAgendaFile: null };

  it("returns null for anything but an array", () => {
    for (const v of [null, undefined, {}, "x", 3, { value: [] }]) expect(parseLegistarEvents(v)).toBeNull();
  });

  it("keeps valid rows, nulls blank optionals, and counts dropped ones", () => {
    const r = parseLegistarEvents([ev, { ...ev, EventDate: "03/04/2026" }, { ...ev, EventId: "abc" }, { ...ev, EventDate: null }, null]);
    expect(r?.rows).toEqual([{ EventId: 5, EventDate: "2026-03-04T00:00:00", EventBodyName: "Council", EventLocation: null, EventAgendaFile: null }]);
    expect(r?.dropped).toBe(4);
  });

  it("accepts a digit-string id", () => {
    expect(parseLegistarEvents([{ ...ev, EventId: "42" }])?.rows[0]?.EventId).toBe(42);
  });
});

describe("parseLegistarEventItems", () => {
  it("requires an id, keeps a blank title for the adapter to skip, and stringifies the matter file", () => {
    const r = parseLegistarEventItems([
      { EventItemId: 1, EventItemTitle: "  ", EventItemMatterFile: 555 },
      { EventItemId: 2, EventItemTitle: "Ok", EventItemActionName: "Adopted" },
      { EventItemTitle: "no id" },
    ]);
    expect(r?.dropped).toBe(1);
    expect(r?.rows[0]).toMatchObject({ EventItemId: 1, EventItemTitle: "  ", EventItemMatterFile: "555" });
    expect(r?.rows[1]).toMatchObject({ EventItemActionName: "Adopted", EventItemMatterFile: null });
  });
});

describe("firstAttachmentUrl", () => {
  it("returns the first hyperlink or null for anything unexpected", () => {
    expect(firstAttachmentUrl([{ MatterAttachmentHyperlink: "https://x/y.pdf" }, { MatterAttachmentHyperlink: "https://x/z.pdf" }])).toBe("https://x/y.pdf");
    for (const v of [[], {}, null, [null], [{}], [{ MatterAttachmentHyperlink: 3 }]]) expect(firstAttachmentUrl(v)).toBeNull();
  });
});

describe("parseUSASpendingPage", () => {
  const a = { "Award ID": "A-1", "Recipient Name": "Acme", "Award Amount": "1000.50", Description: "", "Awarding Agency": "DOT", "Start Date": "2026-01-02" };

  it("returns null unless results is an array", () => {
    for (const v of [null, [], "x", {}, { results: {} }]) expect(parseUSASpendingPage(v)).toBeNull();
  });

  it("coerces numeric-string amounts rather than losing them, and nulls blank optionals", () => {
    const r = parseUSASpendingPage({ results: [a], page_metadata: { has_next_page: true } });
    expect(r?.awards[0]).toMatchObject({ "Award Amount": 1000.5, Description: null });
    expect(r?.hasNextPage).toBe(true);
  });

  it("treats missing/garbled page_metadata as the last page, and drops id-less awards", () => {
    const r = parseUSASpendingPage({ results: [a, { ...a, "Award ID": null }, "x"], page_metadata: "nope" });
    expect(r?.hasNextPage).toBe(false);
    expect(r?.awards).toHaveLength(1);
    expect(r?.dropped).toBe(2);
  });

  it("does not coerce a truthy-but-not-true has_next_page", () => {
    expect(parseUSASpendingPage({ results: [], page_metadata: { has_next_page: "true" } })?.hasNextPage).toBe(false);
  });
});

describe("parsePropublicaPage", () => {
  const o = { ein: 530196605, name: "Org", city: "Pittsburgh", state: "PA", ntee_code: "B20", income_amount: 5, asset_amount: null, filing_date: "2026-01-01", form_type: "990" };

  it("returns null unless organizations is an array", () => {
    for (const v of [null, {}, { organizations: {} }, []]) expect(parsePropublicaPage(v)).toBeNull();
  });

  it("keeps a numeric ein as a number, accepts string eins, and drops rows missing ein or name", () => {
    const r = parsePropublicaPage({ num_pages: 3, organizations: [o, { ...o, ein: "000123" }, { ...o, ein: null }, { ...o, name: "" }] });
    expect(r?.orgs.map((x) => x.ein)).toEqual([530196605, "000123"]);
    expect(r?.dropped).toBe(2);
    expect(r?.numPages).toBe(3);
  });

  it("reads tax_period as YYYYMM from a number or a string, and ignores anything else", () => {
    const period = (v: unknown) => parsePropublicaPage({ organizations: [{ ...o, tax_period: v }] })?.orgs[0]?.tax_period;
    expect(period(202312)).toBe("202312");
    expect(period("202312")).toBe("202312");
    for (const bad of [undefined, null, "", "2023", 20231, 2023120, "Dec 2023", 202313, 202300, 0, {}]) expect(period(bad)).toBeNull();
  });

  it("reports numPages as null when absent or nonsensical", () => {
    for (const n of [undefined, null, "many", -1, NaN]) expect(parsePropublicaPage({ num_pages: n, organizations: [] })?.numPages).toBeNull();
    expect(parsePropublicaPage({ num_pages: 2.9, organizations: [] })?.numPages).toBe(2);
  });
});
