# Changelog

Dates are the release tag's commit date. Versions are [0.x](https://semver.org/#spec-item-4):
a minor bump may change behavior or types; read the **Upgrading** notes below.

## [Unreleased]

## [0.6.0] - 2026-10-29

### Upgrading
- **`AdapterResult` gains `status` and `problems`.** `status` is `ok`, `partial`, `failed` or `skipped`
  (see the README). Code that only reads `inserted` and `skipped` keeps working. Code that constructs an
  `AdapterResult` itself must add both fields. Adapters now **return** `failed` for source-side
  trouble; `ingestLegistar` used to throw when the Events request failed or came back malformed, and
  no longer does. Only errors from your own `sink.save` propagate.

- **`nonprofit_explorer` keys per filing when the response says which one.** The key was
  `propublica:nonprofit:<ein>`, so a new year's return for the same organization was skipped as a
  duplicate of last year's. When the response carries a `tax_period` (YYYYMM) the key is now
  `propublica:nonprofit:<ein>:<tax_period>` (`nonprofitDedupeKey(ein, taxPeriod)`), and `raw.taxPeriod`
  is saved. Rows stored under the old key will be inserted once more, as a second record, on the first
  run after upgrading; the old key is `nonprofitDedupeKey(ein, null)`. If the response has no
  `tax_period` the key is unchanged. It is not confirmed that the live search response carries the field;
  check that `raw.taxPeriod` is populated in your first run.

- **`pdf-parse` is now an optional peer dependency, not a dependency.** If you use PDF sources
  (`blotter_pdf`, PDF `html_minutes`, Legistar PDF attachments), run `npm install pdf-parse` yourself; it
  can be 1.x or 2.x (2.x is maintained and tolerates PDFs that 1.x rejects: a hand-built test PDF failed
  with "bad XRef entry" under 1.x and parsed under 2.x). Without it those sources fail with a message
  saying so, and the package has zero runtime dependencies. The previous install pulled in pdf.js 1.10
  from 2018.

### Changed
- The release workflow's publish job now runs in a GitHub Environment named `npm-publish`, so a human
  approval can be required before anything reaches npm. Nothing changes until you add required reviewers
  to that environment; see `RELEASING.md` for the setup (including the matching field on npmjs.com).
- **PDFs are parsed in an isolated worker thread** (`src/pdf.ts`) with a 512 MB heap ceiling and a 30 s
  deadline. A PDF that hangs or exhausts memory now fails that one run (`failed`, with the reason) and
  the host process carries on. pdf.js's console warnings no longer reach your stdout. This contains
  hangs and runaway memory; it is not a security sandbox, since a worker shares the process's
  permissions.
- **Legistar is no longer serial.** Agenda reads, attachment lookups, PDF fetches and `summarize` calls run
  with bounded concurrency (`meta.concurrency`, default 4, clamped to 1-8). Against a simulated
  50-meeting x 10-item run with 40 ms latency and 300 ms LLM calls, wall time went from 193 s to 49 s.
  Your `summarize` callback is now called concurrently, so it must be safe to run in parallel (and
  mind your provider's rate limits; lower `concurrency` if needed).
- **Legistar reads past 50 events.** It pages 50 at a time up to `meta.maxPages` (default 4, so 200
  events). Hitting the cap is reported as `partial` rather than silently dropping the rest.
- **`html_minutes` reads the whole document.** It used to send the first 8,000 characters to the model
  and drop the rest (a 60,000-character page lost 87%). It now splits into overlapping sections, calls
  `summarize` once per section (up to 3 at a time), merges and de-duplicates the items, and reads up to
  64,000 characters or 60 PDF pages, reporting `partial` past that. The item cap is 200 (was 50).
  Your `summarize` callback is called more than once per document and concurrently.
- **`html_minutes` drops items the model invented.** An item whose title is mostly absent from its source
  section is dropped, and a vote tally that is not in the text is removed from the item; both are
  counted in `problems`. This guards against inventions, not paraphrase errors.
- `html_minutes` failures say why (`HTTP 404`, fetch error, no text in the PDF), and a robots.txt refusal
  is now `skipped` rather than "fetch failed".
- **Response bodies are capped**: 5 MiB for HTML, 25 MiB for JSON and PDFs. An oversized body fails the run
  (`failed`, "response body exceeds N bytes") after reading only a little past the cap; a `Content-Length`
  over the cap is refused before reading. Before, `res.text()` / `res.json()` buffered whatever the server
  sent. A legitimate source bigger than that needs a code change; there is no option for it yet.
- **HTML scanning is linear.** The table parser and the `html_minutes` tag stripper were regexes that
  rescanned to the end of the document at every unclosed tag: a 200 KB page of unclosed nested tables
  blocked the event loop for 448 ms and the cost grew with the square of the size. They are now a single
  pass (`src/html.ts`); 800 KB of the same input takes about 100 ms. On large well-formed pages the new
  scanner is a little slower than the regex was (about 3 MB in 150-200 ms). It also now infers omitted
  `</td>`, `</tr>` and `</table>`, keeps nested tables' cells out of their parent, and ignores tags in
  comments.
- **Redirects are followed one hop at a time and each hop is vetted.** `fetch` used to follow up to 20
  redirects blindly, so a public page could send the request to `http://169.254.169.254/` or to a path
  robots.txt forbids. Now (page, PDF, minutes and Socrata fetches; at most 5 hops) every hop must be
  http(s), not an internal or private address, must not resolve to a private address, and must pass
  robots.txt, otherwise the run fails. A hostname resolving to a private address is also refused for URLs
  discovery gets from the LLM. Nothing changes for a redirect between ordinary public pages. A name this
  machine cannot resolve is not refused. This is a pre-flight check, not protection against true DNS
  rebinding; the README says what to do for that.
- Runs that lost data now say so instead of looking like a clean run: `blotter_html` tables longer than
  500 rows, `blotter_pdf` documents longer than 20 pages, `socrata` rows that were not objects,
  CrimeWatch feeds that stopped answering or were cut at the page cap, and Legistar meetings whose
  agenda could not be read or items whose summary fell back to the title.
- A throwing `summarize` callback no longer aborts a Legistar run; the item keeps its title text and the
  run is `partial`.

## [0.5.0] - 2026-10-28

### Upgrading
- **Breaking: `DiscoveryContext.classify` is replaced by `verify`.** `classify`, `ClassifyFn` and
  `ClassifyResult` are removed. `verify(question, text)` returns the probability (0-1) that the answer
  is yes. A blotter candidate scoring >= 0.7 is accepted, <= 0.3 is rejected, and anything between is
  returned only if no confident candidate turns up, with `needsReview: true` on the `DiscoveredSource`.
  Override the cut-offs with `verifyThresholds: { yes, no }`. A throw or an out-of-range score fails
  open. Code that auto-ingests discovery results should skip or queue entries where `needsReview` is
  true. See the README for a Jev wiring snippet (documented request shape, not yet run against the
  live API).
- **Dedupe keys changed for rows that have no natural id**, so stored rows will insert once more unless
  you migrate: `blotter_html` rows without a case number, and every `blotter_pdf` row. They were keyed
  by position, so one new incident shifted the key of every row below it and re-inserted them all. They
  are now keyed by content (`contentKey` in `src/dedupe.ts`). `blotter_html` rows that have a case
  number keep their keys.

### Added
- `DiscoveryContext.verify`, `verifyThresholds` and `DiscoveredSource.needsReview` (see above).
- Test files are now type-checked (`npm run typecheck` covers `tsconfig.test.json`, and CI runs it).

### Fixed
- Every outbound fetch now has a 30-second deadline; some had none and could hang a run indefinitely.
- Discovery skips candidate URLs that are not public http(s) (localhost, private ranges, cloud
  metadata) instead of fetching them. DNS rebinding and redirects are not covered.
- `robots.txt` handling now follows RFC 9309: `*` and `$` wildcards, longest-match precedence with
  Allow winning ties, a 5xx response treated as disallow-all (cached 5 minutes), a 4xx as allow, and a
  512 KiB cap. A network error still fails open.
- `blotter_html` no longer turns ISO dates into garbage (`2026-03-06` was read as `2006-26-03`).
- Date validation rejects impossible dates (round-trip check), non-`YYYY-MM-DD` prefixes and years
  before 1900.
- CrimeWatch API calls are restricted to crimewatch.net, `*.crimewatchpa.com`, or the page's own host.
  A custom-domain deployment whose API host differs from its page host will be rejected; report one
  if you hit this.

### Development
- Blotter fixture capture and replay harness (`scripts/capture-fixtures.mjs`, `src/fixtures.test.ts`,
  `fixtures/README.md`). Not part of the published package. No real page has been captured yet, so the
  blotter parser tests are still synthetic.
- The release workflow refuses to publish a tag whose commit is not an ancestor of `main`.
- Smaller npm tarball; dev-dependency vulnerabilities cleared (`npm audit` reports none).

## [0.4.1] - 2026-10-20

### Fixed
- Third-party API responses are now validated instead of cast, so one malformed value no longer
  aborts a run or produces colliding records:
  - **Legistar**: an event with a null or missing `EventDate`/`EventId` is skipped (it used to throw and
    lose the whole batch). A non-array `Events` payload fails with a clear error. A bad `EventItems`
    payload falls back to the meeting shell. A meeting with no body name is titled `Meeting — <date>`
    instead of `null Meeting — <date>`.
  - **USASpending / Nonprofit Explorer**: a response missing `results` / `organizations` (or
    `page_metadata`) no longer throws. Numeric-string amounts are still accepted.
  - **Socrata** (records and catalog search): a non-array body stops with a warning; null rows and
    malformed catalog entries are skipped.
- The default `User-Agent` said `civic-data-adapters/0.1`; it now reports the real version, and a test
  keeps it in step with `package.json`.

### Changed
- Rows that lack their natural id are now **skipped** (and counted in a warning) instead of being
  keyed `…:undefined`, which collapsed every such row onto one `dedupeKey`: USASpending awards without
  an `Award ID`, Nonprofit Explorer orgs without an `ein` or `name`. Well-formed data is unaffected.

## [0.4.0] - 2026-10-15

Contains everything in 0.3.0 plus the typed-metadata and validation work below. Those two lines had
diverged (0.3.0 was published without them); 0.4.0 is the first release with both.

### Upgrading
- **`CivicAdapterMeta` is now a union discriminated on `provider`** (types only; runtime behavior is
  unchanged). Object literals typed as `CivicAdapterMeta` must include their provider's required fields
  (`legistar.clientId`; `socrata.url` and `socrata.resourceId`), and fields belonging to another provider no
  longer type-check. Metadata read back from a database is untyped JSON: validate it with
  `parseAdapterMeta` before passing it to `runAdapter`.
- **`html_minutes` `dedupeKey` changed.** The old key used only the first nine characters of the title, so
  distinct items collided and recurring items were dropped after the first meeting. If you already store
  `html_minutes` records, the first run after upgrading re-inserts them unless you migrate. See
  [Upgrading to 0.4](./README.md#upgrading-to-04--html_minutes-dedupe-keys-changed) for the migration
  using `legacyMinutesDedupeKey` and `minutesDedupeKey`.

### Added
- `parseAdapterMeta`, `parseMinutesItems`, `extractJsonArray` (and the `ParseResult`, `MinutesItem`
  types): runtime validation for stored adapter metadata and for LLM output.
- Per-provider meta types (`LegistarMeta`, `SocrataMeta`, …) and the `MetaFor<P>` helper.
- Optional `DiscoveryContext.classify` hook (`ClassifyFn`, `ClassifyResult`): an extra gate on blotter
  candidates that the parsers accepted. Absent, behavior is unchanged; if it throws, discovery fails open.
- `minutesDedupeKey` and `legacyMinutesDedupeKey` exports.
- Tests for the Legistar, `html_minutes`, and all blotter adapters, plus robots.txt and registry dispatch.

### Fixed
- `html_minutes` now validates the model's JSON, drops malformed items (and logs how many), and
  sanitizes dates like every other adapter.
- `blotter_html` parsed ISO dates such as `2026-03-06` as `2006-26-03`.

## [0.3.0] - 2026-07-26

### Added
- `robotsCheck` hook on `AdapterContext` and `DiscoveryContext`: inject your own robots.txt checker so it
  runs instead of the bundled one. Resolution order: `robotsCheck`, then `skipRobotsCheck`, then the bundled
  checker. This removes a redundant second robots.txt fetch per request for adopters that already have one.

## [0.2.0] - 2026-07-25

### Added
- Source discovery behind one caller-supplied LLM callback (`generate`): `discover`, `discoverBlotter`,
  `discoverMeetingPortal`, `searchSocrataCatalog` (no LLM needed), and the `DiscoveredSource` type. The LLM
  proposes candidates and every one is verified by running the real adapter parsers, so a returned source
  has actually yielded data. Discovery proposes; humans approve; adapters ingest.

## [0.1.0] - 2026-07-25

### Added
- Initial release: eight working providers (`legistar`, `html_minutes`, `socrata`, `blotter_html`,
  `blotter_pdf`, `blotter_crimewatch`, `usaspending`, `nonprofit_explorer`), three recognized stubs
  (`granicus`, `civicplus`, `boarddocs`), the `CivicRecordSink` bring-your-own-storage seam, and
  robots.txt compliance on by default.

[Unreleased]: https://github.com/mpointer/civic-data-adapters/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/mpointer/civic-data-adapters/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/mpointer/civic-data-adapters/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mpointer/civic-data-adapters/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mpointer/civic-data-adapters/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mpointer/civic-data-adapters/releases/tag/v0.1.0
