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

`CivicAdapterMeta` is a union discriminated on `provider`, so each provider's required fields are enforced at compile time (`socrata` needs `url` and `resourceId`; `legistar` needs `clientId`) and one provider's fields don't type-check on another. Metadata you read back from a database is untyped JSON, so validate it first:

```ts
import { parseAdapterMeta } from "civic-data-adapters";

const parsed = parseAdapterMeta(row.metadata); // { ok: true, value } | { ok: false, error }
if (parsed.ok) await runAdapter(locality, source, parsed.value, ctx);
```

Every record carries a stable `dedupeKey` (provider plus the source's natural id, or for `html_minutes` the document plus a hash of the full item title), so sinks can upsert idempotently. `MemorySink` ships for tests and dry runs; a real deployment implements the one-method `CivicRecordSink` interface over its own storage.

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

Discovery also accepts an optional `verify` hook, a yes/no check `(question, text) => Promise<number>` returning the probability of yes. When provided, a blotter candidate that the parsers accept is also asked "does this text list individual police incidents?" on the parsed rows. A score ≥ 0.7 accepts; ≤ 0.3 rejects; in between, the candidate is returned only if no confident one turns up, with `needsReview: true` on the result. Override the cut-offs with `verifyThresholds: { yes, no }`. It is an extra gate only: absent, behavior is unchanged; if it throws or returns something outside 0–1, discovery fails open (the parsers stand) and logs a warning.

`verify` maps directly onto a calibrated yes/no endpoint such as [Jev](https://docs.typesafe.ai)'s `noul` question type. The wiring below follows the documented request shape but has **not been run against the live API** (no key was available when it was written), so treat it as a starting point:

```ts
const verify: VerifyFn = async (question, text) => {
  // Jev rate-limits with 429/529: retry with exponential backoff in production.
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
    body: JSON.stringify({
      state: text,
      model: "jev-latest",
      questions: { q: { type: "noul", instructions: question } },
    }),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}`); // discovery fails open
  const body = (await res.json()) as { answers?: { q?: { noul?: number } } };
  return body.answers?.q?.noul as number; // out-of-range or missing → fails open
};
```

Individual entry points also exist: `discoverBlotter`, `discoverMeetingPortal`, and `searchSocrataCatalog` (the catalog one needs no LLM at all).

Two things stated plainly. First, the prompts ask for real, current URLs, so `generate` should be backed by **web-search-grounded** generation; an ungrounded model will hallucinate candidates, which verification then rejects — safe, but you'll get nothing. Second, discovery proposes and humans approve; nothing here auto-provisions scraper targets.

## Upgrading to 0.4 — `html_minutes` dedupe keys changed

The `html_minutes` adapter's `dedupeKey` was `htmlminutes:<sourceId>:<first 12 chars of base64(title)>`. That is only the first nine characters of the title, so distinct items collided ("Resolution 2026-62 …" and "Resolution 2026-63 …": a real nine-item council agenda kept three), and it ignored the document, so a recurring item ("Public comment") was dropped from every meeting after the first.

The key is now `htmlminutes:<sourceId>:<sha1(documentUrl + "\n" + lowercased, trimmed title), first 16 hex>`, exported as `minutesDedupeKey(sourceId, documentUrl, title)`.

**If you already store `html_minutes` records**, the first run after upgrading will treat every item as new and insert it again unless you migrate. `legacyMinutesDedupeKey(sourceId, title)` reproduces the old key so you can find your stored rows and rewrite them (the document URL is the record's `url`):

```ts
for (const row of storedMinutesRows) {
  if (row.dedupeKey === legacyMinutesDedupeKey(row.sourceId, row.title)) {
    row.dedupeKey = minutesDedupeKey(row.sourceId, row.url, row.title);
  }
}
```

(Rows that collided under the old key were already lost; only the first of each colliding group is stored.) Other adapters' keys are unchanged. `blotter_html` and `blotter_pdf` fall back to a positional key when a row has no case number; that is unchanged here, and worth knowing if a source reorders its rows.

## Roadmap

Release history, with upgrade notes, is in [CHANGELOG.md](./CHANGELOG.md). Direction is in [ROADMAP.md](./ROADMAP.md): recorded-fixture tests for the blotter parsers, politeness controls beyond robots.txt, and real Granicus/CivicPlus/BoardDocs adapters when someone does the per-platform work.

## License

Apache-2.0
