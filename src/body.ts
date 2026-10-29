// Read a response body with a size cap. `res.text()` / `res.json()` buffer
// whatever the server sends, so one hostile or broken endpoint could hand back
// gigabytes. Not exported from the package entry point.

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`response body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Caps by kind of content. Generous for real use, small enough to bound memory. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_JSON_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

async function readStream(res: Response, max: number, truncate: boolean): Promise<Uint8Array> {
  const declared = Number(res.headers?.get?.("content-length"));
  if (!truncate && Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(max);
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      if (!truncate) throw new BodyTooLargeError(max);
      parts.push(value.subarray(0, value.byteLength - (total - max)));
      break;
    }
    parts.push(value);
  }
  const out = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Bytes of the body, or BodyTooLargeError past `max` (or truncated to `max` with `truncate`). */
export async function readBytes(res: Response, max: number, opts: { truncate?: boolean } = {}): Promise<Uint8Array> {
  if (!res.body) {
    // No stream (an empty body, or a test double): fall back to the Response API.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength <= max) return buf;
    if (opts.truncate) return buf.subarray(0, max);
    throw new BodyTooLargeError(max);
  }
  return readStream(res, max, opts.truncate === true);
}

/** The body decoded as UTF-8 text, with the same cap rules as `readBytes`. */
export async function readText(res: Response, max: number, opts: { truncate?: boolean } = {}): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (text.length <= max) return text;
    if (opts.truncate) return text.slice(0, max);
    throw new BodyTooLargeError(max);
  }
  return new TextDecoder().decode(await readStream(res, max, opts.truncate === true));
}

/** The body parsed as JSON; throws on invalid JSON or a body past `max`. */
export async function readJson(res: Response, max: number): Promise<unknown> {
  if (!res.body) return res.json();
  return JSON.parse(await readText(res, max));
}
