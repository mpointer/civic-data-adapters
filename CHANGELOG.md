# Changelog

Dates are the release tag's commit date. Versions are [0.x](https://semver.org/#spec-item-4):
a minor bump may change behavior or types; read the **Upgrading** notes below.

## [Unreleased]

### Added
- Blotter fixture capture and replay harness (`scripts/capture-fixtures.mjs`, `src/fixtures.test.ts`,
  `fixtures/README.md`). Development tooling only; it is not part of the published package.
  No real page has been captured yet, so the blotter parser tests are still synthetic.

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
