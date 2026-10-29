import { describe, it, expect, vi } from "vitest";
import { readText, readJson, readBytes, BodyTooLargeError } from "./body.js";

const streamOf = (chunks: Uint8Array[], onCancel?: () => void) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel: onCancel,
  });
const enc = new TextEncoder();

describe("readText / readBytes / readJson", () => {
  it("reads a body under the cap", async () => {
    expect(await readText(new Response("héllo"), 100)).toBe("héllo");
    expect(Array.from(await readBytes(new Response("abc"), 100))).toEqual([97, 98, 99]);
    expect(await readJson(new Response('{"a":1}'), 100)).toEqual({ a: 1 });
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = enc.encode("€uro");
    const res = new Response(streamOf([bytes.slice(0, 2), bytes.slice(2)]));
    expect(await readText(res, 100)).toBe("€uro");
  });

  it("throws BodyTooLargeError when the stream passes the cap, and stops reading", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024);
    const res = new Response(streamOf(Array.from({ length: 1000 }, () => chunk), cancel));
    await expect(readText(res, 4096)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancel).toHaveBeenCalled();
  });

  it("refuses on Content-Length alone without reading the body", async () => {
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const res = new Response(body, { headers: { "content-length": "999999" } });
    await expect(readBytes(res, 1000)).rejects.toThrow(/exceeds 1000 bytes/);
    expect(pull).not.toHaveBeenCalled();
  });

  it("is not fooled by a lying Content-Length", async () => {
    const res = new Response(new Uint8Array(5000), { headers: { "content-length": "10" } });
    await expect(readBytes(res, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("can truncate instead of throwing (robots.txt)", async () => {
    expect(await readText(new Response("abcdefghij"), 4, { truncate: true })).toBe("abcd");
  });

  it("falls back to the response's own methods when there is no stream (test doubles)", async () => {
    expect(await readJson({ json: async () => ({ x: 1 }) } as unknown as Response, 10)).toEqual({ x: 1 });
    expect(await readText({ text: async () => "t" } as unknown as Response, 10)).toBe("t");
  });

  it("rejects invalid JSON like res.json() does", async () => {
    await expect(readJson(new Response("not json"), 100)).rejects.toThrow();
  });
});
