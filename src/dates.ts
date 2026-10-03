// Date sanitization shared by the registry and adapters. Lives in its own
// module so adapters can use it without importing the registry (which imports
// every adapter).

// Civic source data is often messy (a state open-data field can hold a typo'd
// or genuinely wrong date — one state kennel-inspection row arrived dated
// nearly two years in the future, caught in a production review). The record
// date typically drives every "recent activity" view downstream, so an
// unvalidated future date doesn't just look odd — it can make a page
// permanently claim there's upcoming/current activity that hasn't happened.
// Reject anything more than a year out rather than trusting the raw source
// value.
const MAX_FUTURE_DAYS = 366;

export function sanitizeCivicDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iso = raw.slice(0, 10);
  const parsed = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() > Date.now() + MAX_FUTURE_DAYS * 86_400_000) return null;
  return iso;
}
