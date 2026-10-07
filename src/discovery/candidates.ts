// Tolerant JSON extraction for LLM candidate lists. Models asked for "ONLY a
// JSON array" still often wrap it in a markdown fence or a sentence of prose,
// so try the cleaned text first, then the outermost [...] slice. Anything
// unparseable yields [] — discovery treats that as "no candidates", never an
// error.
import { extractJsonArray } from "../validate.js";

/** Parse an LLM reply into candidate objects, keeping only entries whose
 *  `key` field is a non-empty string. */
export function parseCandidateJson<K extends string>(
  raw: string,
  key: K
): Array<Record<K, string>> {
  const arr = extractJsonArray(raw) as Array<Record<K, unknown>> | null;
  return (arr ?? []).filter(
    (c): c is Record<K, string> => typeof c?.[key] === "string" && c[key].trim() !== ""
  );
}

/** "Pittsburgh, PA" → "Pittsburgh"; prefers the explicit city field. */
export function localityCityName(locality: { name: string; city?: string }): string {
  return (locality.city ?? locality.name.split(",")[0] ?? locality.name).trim();
}
