# civic-data-adapters

TypeScript adapters for municipal and civic government data, extracted from a production local-news pipeline. One registry, normalized records, bring-your-own storage.

```
npm install civic-data-adapters
```

## What it covers

Eight working providers:

| Provider | Data |
|---|---|
| `legistar` | Council/board meetings and agenda items (Legistar API) |
| `socrata` | Any Socrata-hosted dataset: blotters, permits, violations, contracts |
| `blotter_html` | Police blotters published as HTML tables (column mapping configurable) |
| `blotter_pdf` | Police blotters published as PDFs |
| `blotter_crimewatch` | CrimeWatch platform blotters |
| `html_minutes` | Free-form HTML meeting minutes (requires an LLM callback, see below) |
| `usaspending` | Federal contracts and grants by locality (USASpending API) |
| `nonprofit_explorer` | Nonprofit filings by locality (ProPublica API) |

Three providers are recognized but stubbed, because they have no public API and need per-site manual setup: `granicus`, `civicplus`, `boarddocs`. The registry logs a warning and returns zeros for them. Contributions welcome; we won't pretend they work.

## Design

Adapters know nothing about your database or your app. Each one takes a locality, a source config, and a context, then hands normalized `CivicRecord`s to your sink:

```ts
import { runAdapter, MemorySink, type CivicAdapterMeta } from "civic-data-adapters";

const sink = new MemorySink(); // or implement CivicRecordSink over your DB

const result = await runAdapter(
  { name: "Springfield", state: "IL" },
  { id: "src-1", url: "https://data.example.gov" },
  {
    provider: "socrata",
    url: "https://data.example.gov",
    resourceId: "abcd-1234",
    recordType: "police_blotter",
    dateField: "incident_date",
  } satisfies CivicAdapterMeta,
  { sink },
);
// result: { inserted, skipped }
```

Every record carries a stable `dedupeKey` (provider plus the source's natural id plus date), so sinks can upsert idempotently. `MemorySink` ships for tests and dry runs; a real deployment implements the one-method `CivicRecordSink` interface over its own storage.

Other things the context controls: `fetch` override (tests, proxies), `userAgent`, and robots.txt checking, which is on by default and fails open. If your codebase already has its own robots implementation, inject it with `robotsCheck: (url) => Promise<boolean>` and it runs instead of the bundled checker, so you don't pay for a second robots.txt fetch per request (`skipRobotsCheck: true` remains the blunt off switch). One testing note, learned from the first adopter's suite: the bundled checker uses `ctx.fetch`, so a test that stubs fetch and asserts call counts will see one extra call per adapter invocation unless it mocks a robots.txt response, sets `skipRobotsCheck`, or injects a `robotsCheck`. Dates pass through `sanitizeCivicDate`, which rejects unparseable values and anything more than a year in the future, because open-data date fields do contain typos and a bad future date can make a "recent activity" view permanently wrong. That one comes from production experience.

## The LLM callback

Two adapters touch unstructured text. `legistar` can summarize agenda items, and `html_minutes` cannot work at all without a parser for free-form minutes. Both use one optional hook:

```ts
ctx.summarize = (systemPrompt, text) => myLlm(systemPrompt, text); // returns Promise<string>
```

Without it, `legistar` falls back to title/action text and `html_minutes` skips with a warning. Bring any LLM. If you want governance around that spend (caps, usage ledger, failover), [llm-governance-gateway](https://github.com/mpointer/llm-governance-gateway)'s `runText` wires in directly, but nothing here requires it:

```ts
ctx.summarize = async (system, text) =>
  (await gw.runText({ slug: "minutes", promptBody: text, system, cache: false, ... })).text;
```

## Discovery (v0.2)

Point at a city and find its civic sources. Discovery proposes candidates through an LLM callback, then **verifies every one by running the real adapter parsers against it**. A returned source has actually yielded data, right now, not "the model thinks this looks right":

```ts
import { discover } from "civic-data-adapters";

const sources = await discover(
  { name: "Springfield", state: "IL" },
  {
    generate: myWebSearchGroundedLlm, // (systemPrompt, prompt) => Promise<string>
    socrataPortalUrl: "https://data.springfield.il.gov", // optional
  },
);
// Each result: { provider, name, meta, evidence }
// evidence reads like "parsed 12 HTML blotter rows just now"
// meta drops straight into runAdapter — after a human approves it.
```

Individual entry points also exist: `discoverBlotter`, `discoverMeetingPortal`, and `searchSocrataCatalog` (the catalog one needs no LLM at all).

Two things stated plainly. First, the prompts ask for real, current URLs, so `generate` should be backed by **web-search-grounded** generation; an ungrounded model will hallucinate candidates, which verification then rejects — safe, but you'll get nothing. Second, discovery proposes and humans approve; nothing here auto-provisions scraper targets.

## Roadmap

See [ROADMAP.md](./ROADMAP.md): recorded-fixture tests for the blotter parsers, politeness controls beyond robots.txt, and real Granicus/CivicPlus/BoardDocs adapters when someone does the per-platform work.

## License

Apache-2.0
