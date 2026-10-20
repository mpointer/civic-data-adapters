# Blotter fixtures

Recorded real pages, replayed through the real parsers by `src/fixtures.test.ts`.
They exist because markup drift on a real department's page is the most likely
way the blotter adapters break, and hand-written test HTML cannot catch it.

## Capture one

```
npm run capture-fixture -- html       pittsburgh-pd   https://example.gov/blotter
npm run capture-fixture -- pdf        smalltown-pd    https://example.gov/blotter.pdf
npm run capture-fixture -- crimewatch hazleton-pd     https://crimewatch.net/us/pa/<county>/<dept>-pd/incidents
```

This builds the package, respects robots.txt, and writes `fixtures/blotter/<name>/`:

| kind | payload | what it is |
|---|---|---|
| `html` | `page.html` | the page exactly as served |
| `pdf` | `document.pdf` | the PDF exactly as served (excerpt 1-2 pages if it is large) |
| `crimewatch` | `exchanges.json` | every HTTP exchange of the feed flow, replayed offline |

A capture that parses to zero rows is **not saved** unless you pass `--allow-empty`
(arguments after `--`). Keep one on purpose when you want a "this layout broke us"
regression.

## Before you commit: personal information

Blotters name real people, addresses, and arrests, and this repository is public.
Being a public record does not mean it should be republished here.

1. Open the payload and `meta.json`. Redact or replace names and exact addresses.
   Prefer a page or excerpt with few of them. Edit the payload by hand.
2. Set `"reviewedForPii": true` in `meta.json`.
3. Write the expected-output snapshot and **read it**, because it holds parsed rows too:

   ```
   npx vitest run src/fixtures.test.ts -u
   ```

The test fails for any fixture whose `reviewedForPii` is not `true`, so an
unreviewed capture cannot be merged green by accident. (Put `-u` after the
file name; before it, vitest treats the filename as the flag's value.)

## What the test checks

- the fixture was reviewed (above);
- it parses to at least one row (unless `meta.json` has `"allowEmpty": true`);
- the parsed rows equal `fixtures/blotter/__expected__/<name>.json`. A parser change
  that alters what a real page yields shows as a diff to review, and re-running
  with `-u` accepts it deliberately.

`.gitattributes` marks `fixtures/**` as `-text` so Windows line-ending conversion
cannot silently change captured bytes.

CrimeWatch replays are strict: if a change makes the adapter send a request that was
not recorded (different page size, new bundle), the test fails with
`no recorded exchange for: ...` instead of guessing. Re-capture with `--force`.
