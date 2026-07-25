# Roadmap

v0.1.0 shipped adapters only: eight working providers, three honest stubs,
bring-your-own storage, robots.txt compliance, live-validated against
Legistar, Socrata, USASpending, and ProPublica.

## v0.2 — discovery

The headline for v2 is the part that makes demos magical: point at a city
and find its civic sources. All of it lands behind one caller-supplied LLM
callback (`generate: (prompt) => Promise<string>`), with
[llm-governance-gateway](https://github.com/mpointer/llm-governance-gateway)
as the documented but never required provider.

- [x] Blotter discovery: given a locality, find its police blotter (HTML,
      PDF, CrimeWatch, or Socrata) and emit ready-to-use `CivicAdapterMeta`.
      Ported from the production pipeline's discovery module.
- [x] Meeting-portal discovery: find a city's Legistar/Granicus/CivicPlus/
      BoardDocs instance and classify which provider it is.
- [x] Socrata catalog search: find relevant datasets on a city's open-data
      portal and propose adapter configs (ported; currently excluded because
      it provisioned sources directly into the origin app's tables — v2 gives
      it a clean `DiscoveredSource[]` return contract instead).
- [x] A `discover` entry point that runs all three and returns proposed
      source configs for human review. Discovery proposes; humans approve;
      adapters ingest.

## v0.2 candidates that aren't discovery

- [ ] Recorded-fixture tests for the blotter adapters (HTML/PDF/CrimeWatch) —
      they're currently covered structurally but not against captured real
      pages, and blotter markup drift is the most likely breakage.
- [ ] Politeness controls: per-host request spacing and honoring
      crawl-delay, beyond the existing robots.txt allow/deny. Public civic
      infrastructure deserves gentler defaults than commercial APIs.
- [ ] Locality-aware Socrata `$where` templating (city/county filters) so
      big shared state portals don't require hand-written field configs.

## Later / on demand

- [ ] Real granicus/civicplus/boarddocs adapters — currently stubs because
      there's no public API; each needs per-platform scraping work.
      Contributions welcome; they stay stubs until they actually work.
- [ ] Reference `CivicRecordSink` for Drizzle (sqlite + pg), mirroring the
      gateway's reference stores, if adopters ask for it.
- [ ] More states' blotter platforms beyond CrimeWatch (which is PA-centric)
      as contributors surface them.

## Non-goals

- Storing data. The sink interface is the boundary; this package never
  owns a database.
- A hosted service or scheduler. Cron is your job; ingestion is ours.
- Pretending stubs work. Provider support claims stay grep-provable.
