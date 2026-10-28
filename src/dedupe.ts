// Content-based dedupe keys for sources that give rows no stable id.
//
// A blotter row without a case number used to be keyed by its position on the
// page. Blotters list newest first, so one new incident shifted every other row
// down by one and each of them was re-inserted as a "new" record on the next run.
// A key built from the row's own content is stable under insertions, removals
// and reordering.
import { createHash } from "node:crypto";

/**
 * Hash the parts into a stable key. Pass one `seen` map per document: rows with
 * identical content get an occurrence suffix (`:1`, `:2`) so genuine repeats on
 * one page stay distinct, and stay stable run to run because identical rows are
 * interchangeable.
 */
export function contentKey(
  parts: ReadonlyArray<string | null | undefined>,
  seen: Map<string, number>
): string {
  const normalized = parts.map((p) => (p ?? "").replace(/\s+/g, " ").trim());
  const digest = createHash("sha1").update(normalized.join("\u0001")).digest("hex").slice(0, 16);
  const occurrence = (seen.get(digest) ?? 0) + 1;
  seen.set(digest, occurrence);
  return `${digest}:${occurrence}`;
}
