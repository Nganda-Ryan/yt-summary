import type { Segment } from "./transcript";

function stripMarks(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

export function matchQuery(text: string, query: string): boolean {
  const tokens = stripMarks(query)
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = stripMarks(text).toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

export interface HighlightPart {
  text: string;
  match: boolean;
}

/** Découpe `text` pour surligner les tokens de `query` (casse et accents ignorés). */
export function highlightQuery(text: string, query: string): HighlightPart[] {
  const tokens = stripMarks(query)
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0 || text.length === 0) return [{ text, match: false }];

  const origChars = Array.from(text);
  const normChars: string[] = [];
  const origIndexForNorm: number[] = [];
  origChars.forEach((char, index) => {
    const normalized = stripMarks(char).toLowerCase();
    for (const unit of normalized) {
      normChars.push(unit);
      origIndexForNorm.push(index);
    }
  });
  const hay = normChars.join("");
  const matchedOrig = new Array(origChars.length).fill(false);
  for (const token of tokens) {
    let from = 0;
    while (from <= hay.length - token.length) {
      const at = hay.indexOf(token, from);
      if (at === -1) break;
      const startOrig = origIndexForNorm[at];
      const endOrig = origIndexForNorm[at + token.length - 1] + 1;
      for (let i = startOrig; i < endOrig; i += 1) matchedOrig[i] = true;
      from = at + 1;
    }
  }

  const parts: HighlightPart[] = [];
  let buffer = "";
  let matching = matchedOrig[0] === true;
  for (let i = 0; i < origChars.length; i += 1) {
    const isMatch = matchedOrig[i] === true;
    if (isMatch !== matching && buffer.length > 0) {
      parts.push({ text: buffer, match: matching });
      buffer = "";
      matching = isMatch;
    }
    buffer += origChars[i];
  }
  if (buffer.length > 0) parts.push({ text: buffer, match: matching });
  return parts;
}

/** 12:40 ou 1:02:03 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** 00:01:02,400 (format SRT) */
export function formatSrtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

/** Texte horodaté : « [12:40] texte… » par ligne. */
export function toPlainText(segments: Segment[]): string {
  return segments
    .map((segment) => `[${formatClock(segment.start)}] ${segment.text}`)
    .join("\n");
}

/** Résumé exporté en texte : digest + titre + paragraphe par idée. */
export function toSummaryPlainText(
  sections: Array<{ start: number; title: string; summary: string }>,
  essence = "",
): string {
  const body = sections
    .map((section) => `[${formatClock(section.start)}] ${section.title}\n${section.summary}`.trim())
    .join("\n\n");
  const digest = essence.trim();
  return digest ? `${digest}\n\n${body}` : body;
}

/** Fichier .srt standard. */
export function toSrt(segments: Segment[]): string {
  return segments
    .map((segment, index) => {
      const start = formatSrtTime(segment.start);
      const end = formatSrtTime(segment.start + Math.max(segment.duration, 0.5));
      return `${index + 1}\n${start} --> ${end}\n${segment.text}\n`;
    })
    .join("\n");
}

export interface MarkdownExport {
  title: string;
  videoId: string;
  segments: Segment[];
  sections?: Array<{ start: number; title: string; summary: string }>;
  essence?: string;
  includeTranscript?: boolean;
}

function watchUrl(videoId: string, seconds?: number): string {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  return seconds === undefined ? base : `${base}&t=${Math.max(0, Math.floor(seconds))}s`;
}

function timestampLink(videoId: string, seconds: number): string {
  const clock = formatClock(seconds);
  return `[${clock}](${watchUrl(videoId, seconds)})`;
}

/** Markdown avec titre, liens horodatés, et résumé s'il existe. */
export function toMarkdown({
  title,
  videoId,
  segments,
  sections,
  essence,
  includeTranscript = true,
}: MarkdownExport): string {
  const heading = title.trim() || `Vidéo ${videoId}`;
  const lines: string[] = [`# ${heading}`, "", watchUrl(videoId), ""];

  if (essence?.trim()) {
    lines.push("## Essence", "", essence.trim(), "");
  }

  if (sections && sections.length > 0) {
    lines.push("## Résumé par idées", "");
    for (const section of sections) {
      lines.push(`- [${timestampLink(videoId, section.start)}] ${section.title}`);
      if (section.summary.trim()) {
        lines.push(`  ${section.summary.trim()}`);
      }
    }
    lines.push("");
  }

  if (includeTranscript) {
    lines.push("## Transcription", "");
    for (const segment of segments) {
      lines.push(`- [${timestampLink(videoId, segment.start)}] ${segment.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
