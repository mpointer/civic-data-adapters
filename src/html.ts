// Linear-time HTML scanning for the table and text extractors. The regexes
// this replaces (`<table>...</table>` with lazy `[\s\S]*?`) rescanned to the end
// of the document at every unclosed tag, so a 200 KB page of unclosed tags cost
// about half a second and the cost grew with the square of the size. This scans
// once. It is not an HTML parser: it knows tags, comments, and script/style.
// Not exported from the package entry point (parseHtmlTables is re-exported by
// the blotter-html adapter).

type Token =
  | { kind: "text"; text: string }
  | { kind: "tag"; name: string; closing: boolean };

/** Yield text and tags in document order. Comments vanish; script/style bodies vanish. */
function* scan(html: string): Generator<Token> {
  const lower = html.toLowerCase();
  const n = html.length;
  let i = 0;
  let textStart = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      if (lt > textStart) yield { kind: "text", text: html.slice(textStart, lt) };
      const end = html.indexOf("-->", lt + 4);
      yield { kind: "text", text: " " };
      i = textStart = end === -1 ? n : end + 3;
      continue;
    }
    // A tag name is letters (and digits) straight after "<" or "</".
    let j = lt + 1;
    const closing = html[j] === "/";
    if (closing) j++;
    const nameStart = j;
    for (let c = lower.charCodeAt(j); (c >= 97 && c <= 122) || (c >= 48 && c <= 57); c = lower.charCodeAt(++j));
    if (j === nameStart) {
      // Not a tag ("5 < 6", "<!doctype", "<?xml", "<>"): "<" is text unless it is a declaration.
      if (html[lt + 1] === "!" || html[lt + 1] === "?") {
        if (lt > textStart) yield { kind: "text", text: html.slice(textStart, lt) };
        const gt = html.indexOf(">", lt + 1);
        i = textStart = gt === -1 ? n : gt + 1;
      } else {
        i = lt + 1;
      }
      continue;
    }
    const name = lower.slice(nameStart, j);
    const gt = html.indexOf(">", j);
    if (gt === -1) {
      // Unterminated tag: the rest of the document is inside it.
      if (lt > textStart) yield { kind: "text", text: html.slice(textStart, lt) };
      return;
    }
    if (lt > textStart) yield { kind: "text", text: html.slice(textStart, lt) };
    yield { kind: "tag", name, closing };
    i = textStart = gt + 1;
    if (!closing && (name === "script" || name === "style")) {
      const close = lower.indexOf(`</${name}`, i);
      if (close === -1) return;
      const gt2 = html.indexOf(">", close);
      yield { kind: "tag", name, closing: true };
      i = textStart = gt2 === -1 ? n : gt2 + 1;
    }
  }
  if (textStart < n) yield { kind: "text", text: html.slice(textStart) };
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Visible text: tags, comments, scripts and styles removed, whitespace collapsed. */
export function htmlToText(html: string): string {
  const out: string[] = [];
  for (const t of scan(html)) out.push(t.kind === "text" ? t.text : " ");
  return collapse(out.join(""));
}

interface TableState {
  rows: string[][];
  row: string[] | null;
  cell: string[] | null;
}

/**
 * Rows of cell text for every table with at least two rows, in the order the
 * tables close. Omitted </td>, </tr> and </table> are inferred the way
 * browsers do; a nested table's cells stay out of its parent.
 */
export function parseHtmlTables(html: string): string[][][] {
  const tables: string[][][] = [];
  const stack: TableState[] = [];
  const closeCell = (t: TableState) => {
    if (t.cell) {
      (t.row ??= []).push(collapse(t.cell.join("")));
      t.cell = null;
    }
  };
  const closeRow = (t: TableState) => {
    closeCell(t);
    if (t.row?.length) t.rows.push(t.row);
    t.row = null;
  };
  const closeTable = () => {
    const t = stack.pop();
    if (!t) return;
    closeRow(t);
    if (t.rows.length > 1) tables.push(t.rows);
  };

  for (const tok of scan(html)) {
    const top = stack[stack.length - 1];
    if (tok.kind === "text") {
      top?.cell?.push(tok.text);
      continue;
    }
    switch (tok.name) {
      case "table":
        if (tok.closing) closeTable();
        else stack.push({ rows: [], row: null, cell: null });
        break;
      case "tr":
        if (top) {
          closeRow(top);
          if (!tok.closing) top.row = [];
        }
        break;
      case "td":
      case "th":
        if (top) {
          closeCell(top);
          if (!tok.closing) top.cell = [];
        }
        break;
    }
  }
  while (stack.length) closeTable();
  return tables;
}
