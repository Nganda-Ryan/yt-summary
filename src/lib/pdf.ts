import { formatClock } from "./format";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const TITLE_SIZE = 18;
const HEADING_SIZE = 13;
const BODY_SIZE = 11;
const URL_SIZE = 10;
const BODY_LEADING = 16;
const BULLET_INDENT = 16;
const LINK_BLUE: RGB = [0.12, 0.45, 0.82];
const INK: RGB = [0.12, 0.12, 0.14];
const MUTED: RGB = [0.35, 0.35, 0.38];
const RULE: RGB = [0.86, 0.86, 0.88];

type RGB = [number, number, number];
type Face = "regular" | "bold";

export interface PdfItem {
  start: number;
  title?: string;
  text: string;
}

export interface PdfDocument {
  title: string;
  videoId: string;
  heading: string;
  essence?: string;
  items: PdfItem[];
}

interface Run {
  text: string;
  face: Face;
  size: number;
  color: RGB;
  href?: string;
}

interface LinkBox {
  x: number;
  y: number;
  w: number;
  h: number;
  uri: string;
}

interface PageModel {
  ops: string[];
  links: LinkBox[];
}

const HELVETICA: number[] = [];
const HELVETICA_ASCII =
  "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 " +
  "556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 " +
  "1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 " +
  "667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 " +
  "333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 " +
  "556 556 333 500 278 556 500 722 500 500 500 334 260 334 584";

for (let i = 0; i < 256; i += 1) HELVETICA[i] = 556;
HELVETICA_ASCII.split(" ").forEach((value, index) => {
  HELVETICA[32 + index] = Number(value);
});
HELVETICA[9] = 278;
HELVETICA[0xe9] = 556;
HELVETICA[0xe8] = 556;
HELVETICA[0xea] = 556;
HELVETICA[0xe0] = 556;
HELVETICA[0xe2] = 556;
HELVETICA[0xe7] = 500;
HELVETICA[0xf9] = 556;
HELVETICA[0xfb] = 556;
HELVETICA[0xf4] = 556;
HELVETICA[0xee] = 222;
HELVETICA[0xc9] = 667;
HELVETICA[0xc0] = 667;
HELVETICA[0xc7] = 667;

function toWinAnsi(text: string): string {
  const extras: Record<string, string> = {
    "\u2018": "'",
    "\u2019": "'",
    "\u201C": '"',
    "\u201D": '"',
    "\u2013": "-",
    "\u2014": "-",
    "\u2026": "...",
    "\u00A0": " ",
    "\u202F": " ",
    "\u0153": "oe",
    "\u0152": "OE",
    "•": "•",
  };
  return Array.from(text)
    .map((char) => {
      if (char === "•") return "\xB7";
      if (extras[char]) return extras[char];
      const code = char.charCodeAt(0);
      if (code < 128 || (code >= 0xa0 && code <= 0xff)) return char;
      return "?";
    })
    .join("");
}

function pdfLiteral(text: string): string {
  const ansi = toWinAnsi(text);
  let out = "(";
  for (let i = 0; i < ansi.length; i += 1) {
    const code = ansi.charCodeAt(i);
    if (code === 0x5c || code === 0x28 || code === 0x29) out += `\\${ansi[i]}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += ansi[i];
  }
  return `${out})`;
}

function pdfHexUri(uri: string): string {
  let hex = "";
  for (let i = 0; i < uri.length; i += 1) {
    hex += uri.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return `<${hex}>`;
}

function glyphWidth(char: string, face: Face, size: number): number {
  const ansi = toWinAnsi(char);
  let width = 0;
  for (let i = 0; i < ansi.length; i += 1) {
    width += HELVETICA[ansi.charCodeAt(i)] ?? 556;
  }
  const bold = face === "bold" ? 1.03 : 1;
  return (width * size * bold) / 1000;
}

function textWidth(text: string, face: Face, size: number): number {
  return glyphWidth(text, face, size);
}

function rgb(color: RGB): string {
  return `${color[0]} ${color[1]} ${color[2]} rg`;
}

function watchUrl(videoId: string, seconds?: number): string {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  return seconds === undefined ? base : `${base}&t=${Math.max(0, Math.floor(seconds))}s`;
}

function newPage(): PageModel {
  return { ops: [], links: [] };
}

function drawText(page: PageModel, x: number, y: number, run: Run): number {
  const font = run.face === "bold" ? "F2" : "F1";
  page.ops.push("BT");
  page.ops.push(rgb(run.color));
  page.ops.push(`/${font} ${run.size} Tf`);
  page.ops.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`);
  page.ops.push(`${pdfLiteral(run.text)} Tj`);
  page.ops.push("ET");
  const width = textWidth(run.text, run.face, run.size);
  if (run.href) {
    page.links.push({
      x,
      y: y - 2,
      w: width,
      h: run.size + 3,
      uri: run.href,
    });
  }
  return width;
}

function drawRule(page: PageModel, y: number): void {
  page.ops.push(`${RULE[0]} ${RULE[1]} ${RULE[2]} RG`);
  page.ops.push("0.6 w");
  page.ops.push(`${MARGIN} ${y.toFixed(2)} m ${PAGE_WIDTH - MARGIN} ${y.toFixed(2)} l S`);
}

function wrapWords(
  words: Array<{ word: string; face: Face; size: number; color: RGB; href?: string }>,
  firstWidth: number,
  nextWidth: number,
): Run[][] {
  const lines: Run[][] = [];
  let current: Run[] = [];
  let used = 0;
  let limit = firstWidth;

  const flush = () => {
    if (current.length) lines.push(current);
    current = [];
    used = 0;
    limit = nextWidth;
  };

  for (const token of words) {
    const space = current.length ? textWidth(" ", token.face, token.size) : 0;
    const wordWidth = textWidth(token.word, token.face, token.size);
    if (used + space + wordWidth > limit && current.length) flush();
    if (current.length) {
      const last = current[current.length - 1];
      if (last.face === token.face && last.size === token.size && last.color.join() === token.color.join() && last.href === token.href) {
        last.text += ` ${token.word}`;
        used += space + wordWidth;
        continue;
      }
      current.push({ text: ` ${token.word}`, face: token.face, size: token.size, color: token.color, href: token.href });
      used += space + wordWidth;
      continue;
    }
    current.push({ text: token.word, face: token.face, size: token.size, color: token.color, href: token.href });
    used = wordWidth;
  }
  flush();
  return lines;
}

function layoutDocument(doc: PdfDocument): PageModel[] {
  const pages: PageModel[] = [];
  let page = newPage();
  let y = PAGE_HEIGHT - MARGIN - TITLE_SIZE;

  const ensure = (need: number) => {
    if (y - need < MARGIN) {
      pages.push(page);
      page = newPage();
      y = PAGE_HEIGHT - MARGIN - BODY_SIZE;
    }
  };

  const title = doc.title.trim() || "YouTube";
  const titleLines = wrapWords(
    title.split(/\s+/).map((word) => ({ word, face: "bold" as const, size: TITLE_SIZE, color: INK })),
    CONTENT_WIDTH,
    CONTENT_WIDTH,
  );
  for (const line of titleLines) {
    ensure(TITLE_SIZE + 4);
    let x = MARGIN;
    for (const run of line) x += drawText(page, x, y, run);
    y -= TITLE_SIZE + 6;
  }

  y -= 4;
  drawRule(page, y);
  y -= 18;

  const url = watchUrl(doc.videoId);
  ensure(URL_SIZE + 8);
  drawText(page, MARGIN, y, {
    text: url,
    face: "regular",
    size: URL_SIZE,
    color: LINK_BLUE,
    href: url,
  });
  y -= 28;

  ensure(HEADING_SIZE + 10);
  drawText(page, MARGIN, y, {
    text: doc.heading,
    face: "bold",
    size: HEADING_SIZE,
    color: INK,
  });
  y -= HEADING_SIZE + 14;

  const essence = doc.essence?.trim() ?? "";
  if (essence) {
    const essenceLines = wrapWords(
      essence.split(/\s+/).map((word) => ({ word, face: "regular" as const, size: BODY_SIZE, color: MUTED })),
      CONTENT_WIDTH,
      CONTENT_WIDTH,
    );
    for (const line of essenceLines) {
      ensure(BODY_LEADING);
      let x = MARGIN;
      for (const run of line) x += drawText(page, x, y, run);
      y -= BODY_LEADING;
    }
    y -= 12;
  }

  for (const item of doc.items) {
    const stamp = `[${formatClock(item.start)}]`;
    const href = watchUrl(doc.videoId, item.start);
    const prefixWidth =
      textWidth("·  ", "regular", BODY_SIZE) + textWidth(stamp, "regular", BODY_SIZE) + textWidth(" ", "regular", BODY_SIZE);
    const restWords: Array<{ word: string; face: Face; size: number; color: RGB }> = [];
    if (item.title?.trim()) {
      for (const word of item.title.trim().split(/\s+/)) {
        restWords.push({ word, face: "bold", size: BODY_SIZE, color: INK });
      }
    }
    if (item.text.trim()) {
      for (const word of item.text.trim().split(/\s+/)) {
        restWords.push({ word, face: "regular", size: BODY_SIZE, color: MUTED });
      }
    }

    const wrapped = wrapWords(restWords, CONTENT_WIDTH - prefixWidth, CONTENT_WIDTH - BULLET_INDENT);
    const lineCount = Math.max(1, wrapped.length);
    ensure(lineCount * BODY_LEADING + 8);

    let x = MARGIN;
    x += drawText(page, x, y, { text: "·  ", face: "regular", size: BODY_SIZE, color: INK });
    x += drawText(page, x, y, {
      text: stamp,
      face: "regular",
      size: BODY_SIZE,
      color: LINK_BLUE,
      href,
    });
    x += drawText(page, x, y, { text: " ", face: "regular", size: BODY_SIZE, color: INK });
    if (wrapped[0]) {
      for (const run of wrapped[0]) x += drawText(page, x, y, run);
    }
    y -= BODY_LEADING;

    for (let i = 1; i < wrapped.length; i += 1) {
      ensure(BODY_LEADING);
      x = MARGIN + BULLET_INDENT;
      for (const run of wrapped[i]) x += drawText(page, x, y, run);
      y -= BODY_LEADING;
    }
    y -= 8;
  }

  pages.push(page);
  return pages;
}

function latin1Bytes(source: string): Uint8Array {
  const bytes = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 1) bytes[i] = source.charCodeAt(i) & 0xff;
  return bytes;
}

function serialize(objects: string[]): Uint8Array {
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return latin1Bytes(pdf);
}

export function documentToPdf(doc: PdfDocument): Uint8Array {
  const pages = layoutDocument(doc);
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  const pageIds: number[] = [];
  let nextId = 5;
  for (const page of pages) {
    const stream = page.ops.join("\n");
    const streamId = nextId++;
    objects[streamId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    const annotIds: number[] = [];
    for (const link of page.links) {
      const annotId = nextId++;
      annotIds.push(annotId);
      const rect = `${link.x.toFixed(2)} ${link.y.toFixed(2)} ${(link.x + link.w).toFixed(2)} ${(link.y + link.h).toFixed(2)}`;
      objects[annotId] =
        `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /C [0.12 0.45 0.82] ` +
        `/A << /S /URI /URI ${pdfHexUri(link.uri)} >> >>`;
    }
    const pageId = nextId++;
    pageIds.push(pageId);
    const annots = annotIds.length ? ` /Annots [${annotIds.map((id) => `${id} 0 R`).join(" ")}]` : "";
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R${annots} >>`;
  }

  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  return serialize(objects);
}
