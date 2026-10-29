// PDF text extraction, isolated. pdf.js is a large parser of hostile input
// (anyone can post a PDF to a public blotter page), so it runs in a worker
// thread with a memory ceiling and a deadline: a PDF that hangs or exhausts
// memory costs one worker, not the host process. pdf-parse is an OPTIONAL peer
// dependency (1.x or 2.x) so the PDF engine is the consumer's to keep patched.
// Not exported from the package entry point.
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const requireFromHere = createRequire(import.meta.url);

export interface PdfText {
  text: string;
  /** Pages in the document, when the parser reports it. */
  numpages: number | null;
}

export interface PdfLimits {
  /** Pages to read from the start. */
  maxPages: number;
  /** Give up after this long (default 30 s). */
  timeoutMs?: number;
  /** Heap ceiling for the worker (default 512 MB). */
  memoryMb?: number;
}

export class PdfParserMissingError extends Error {
  constructor(specifier: string) {
    super(
      `PDF support needs the optional peer dependency "${specifier}": run \`npm install pdf-parse\` (1.x or 2.x)`
    );
    this.name = "PdfParserMissingError";
  }
}

/** Absolute path of the installed parser, or PdfParserMissingError. */
export function resolveParser(specifier = "pdf-parse"): string {
  try {
    return requireFromHere.resolve(specifier);
  } catch {
    throw new PdfParserMissingError(specifier);
  }
}

// Runs inside the worker. Plain JS in a string (not a function's toString)
// so no build step can rewrite it. Handles both pdf-parse APIs: 1.x is a
// function (buffer, { max }) -> { text, numpages }; 2.x is a class
// new PDFParse({ data }).getText({ first }) -> { text, total }.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { modulePath, bytes, maxPages } = workerData;
  const mod = require(modulePath);
  let text;
  let numpages = null;
  if (typeof mod === "function") {
    const r = await mod(Buffer.from(bytes), { max: maxPages });
    text = r.text;
    if (typeof r.numpages === "number") numpages = r.numpages;
  } else if (mod && typeof mod.PDFParse === "function") {
    const parser = new mod.PDFParse({ data: bytes });
    try {
      const r = await parser.getText({ first: maxPages });
      text = r.text;
      if (typeof r.total === "number") numpages = r.total;
    } finally {
      await Promise.resolve(parser.destroy()).catch(() => {});
    }
  } else {
    throw new Error("unsupported pdf-parse API (need pdf-parse 1.x or 2.x)");
  }
  parentPort.postMessage({ ok: true, text: String(text == null ? "" : text), numpages });
})().catch((e) => parentPort.postMessage({ ok: false, error: String((e && e.message) || e) }));
`;

type WorkerReply = { ok: true; text: string; numpages: number | null } | { ok: false; error: string };

/**
 * Extract the text of the first `maxPages` pages of `bytes`. Rejects on an
 * unparseable PDF, on exceeding the deadline or memory ceiling, or when no
 * parser is installed. `parser` is a module path (tests point it elsewhere).
 */
export function parsePdf(bytes: Uint8Array, limits: PdfLimits, parser = resolveParser()): Promise<PdfText> {
  const timeoutMs = limits.timeoutMs ?? 30_000;
  const memoryMb = limits.memoryMb ?? 512;
  return new Promise<PdfText>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { modulePath: parser, bytes, maxPages: limits.maxPages },
      resourceLimits: { maxOldGenerationSizeMb: memoryMb },
      // Capture instead of inheriting: pdf.js writes warnings to stdout.
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`PDF parsing timed out after ${timeoutMs} ms`))),
      timeoutMs
    );

    worker.on("message", (m: WorkerReply) =>
      finish(() =>
        m.ok ? resolve({ text: m.text, numpages: m.numpages }) : reject(new Error(m.error))
      )
    );
    worker.on("error", (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          err.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new Error(`PDF parser ran out of memory (limit ${memoryMb} MB)`)
            : err
        )
      )
    );
    worker.on("exit", () => finish(() => reject(new Error("PDF parser exited without a result"))));
  });
}
