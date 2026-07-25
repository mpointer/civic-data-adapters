// Tolerant JSON extraction for LLM candidate lists. Models asked for "ONLY a
// JSON array" still often wrap it in a markdown fence or a sentence of prose,
// so try the cleaned text first, then the outermost [...] slice. Anything
// unparseable yields [] — discovery treats that as "no candidates", never an
// error.

/** Parse an LLM reply into candidate objects, keeping only entries whose
 *  `key` field is a non-empty string. */
export function parseCandidateJson<K extends string>(
  raw: string,
  key: K
): Array<Record<K, string>> {
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");
  for (const text of [cleaned, cleaned.slice(cleaned.indexOf("["), cleaned.lastIndexOf("]") + 1)]) {
    try {
      const arr = JSON.parse(text) as Array<Record<K, unknown>>;
      if (Array.isArray(arr)) {
        return arr.filter(
          (c): c is Record<K, string> => typeof c?.[key] === "string" && c[key].trim() !== ""
        );
      }
    } catch {
      /* try next */
    }
  }
  return [];
}

/** "Pittsburgh, PA" → "Pittsburgh"; prefers the explicit city field. */
export function localityCityName(locality: { name: string; city?: string }): string {
  return (locality.city ?? locality.name.split(",")[0] ?? locality.name).trim();
}
