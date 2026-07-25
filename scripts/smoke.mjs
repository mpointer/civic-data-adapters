// Live smoke test against real public civic APIs. No API keys required.
//   npm run build && node scripts/smoke.mjs
//
// Exercises the four API-backed adapters (legistar, socrata, usaspending,
// nonprofit_explorer) with a MemorySink. The blotter/minutes adapters need
// site-specific source URLs and are covered by unit fixtures instead.
//
// These hit third-party government/nonprofit APIs: results vary with the
// data (a quiet week can legitimately return 0 records), so the pass bar is
// "the request succeeded and parsed", with record counts reported for eyes.

import { runAdapter, MemorySink } from "../dist/index.js";

let failures = 0;

async function smoke(name, locality, meta) {
  const sink = new MemorySink();
  // The adapters fail SOFT on fetch errors by design (a broken source must
  // not kill a production ingest run). A smoke test has the opposite
  // contract: any fetch/HTTP error counts as a failure, so capture warnings.
  const errors = [];
  const logger = {
    log(m, level = "info") {
      if (/fetch error|→ \d{3}|failed/i.test(m)) errors.push(m);
      console[level === "warn" ? "warn" : "log"](`    ${m}`);
    },
  };
  try {
    const res = await runAdapter(locality, { id: `smoke-${name}` }, meta, { sink, logger });
    if (errors.length > 0) {
      console.error(`[${name}] FAILED: adapter reported ${errors.length} fetch/HTTP error(s)`);
      failures++;
      return;
    }
    const sample = [...sink.records.values()][0];
    console.log(
      `[${name}] ok: inserted=${res.inserted} skipped=${res.skipped}` +
        (sample ? ` | sample: "${sample.title?.slice(0, 70)}" (${sample.date})` : " | no records in window"),
    );
  } catch (e) {
    console.error(`[${name}] FAILED: ${e.message}`);
    failures++;
  }
}

// Legistar: Seattle runs a public Legistar instance.
await smoke("legistar", { name: "Seattle", state: "WA" }, {
  provider: "legistar",
  clientId: "seattle",
});

// Socrata: NYC 311 service requests — large, stable, public.
await smoke("socrata", { name: "New York", state: "NY" }, {
  provider: "socrata",
  url: "https://data.cityofnewyork.us",
  resourceId: "erm2-nwe9",
  recordType: "violation",
  dateField: "created_date",
  typeField: "complaint_type",
  descriptionField: "descriptor",
  locationField: "incident_address",
  caseField: "unique_key",
});

// USASpending: federal awards for a mid-size city.
await smoke("usaspending", { name: "Scranton", city: "Scranton", state: "PA" }, {
  provider: "usaspending",
  awardTypes: "all",
  lookbackDays: 365,
});

// ProPublica Nonprofit Explorer.
await smoke("nonprofit", { name: "Scranton", city: "Scranton", state: "PA" }, {
  provider: "nonprofit_explorer",
  lookbackDays: 365,
});

if (failures > 0) {
  console.error(`\nSmoke finished with ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll API-backed adapters passed against live endpoints.");
