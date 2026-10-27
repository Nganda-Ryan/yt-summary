import type { Segment } from "./transcript";

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

/** Résumé exporté en texte : titre + paragraphe par idée. */
export function toSummaryPlainText(
  sections: Array<{ start: number; title: string; summary: string }>,
): string {
  return sections
    .map((section) => `[${formatClock(section.start)}] ${section.title}\n${section.summary}`.trim())
    .join("\n\n");
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
  includeTranscript = true,
}: MarkdownExport): string {
  const heading = title.trim() || `Vidéo ${videoId}`;
  const lines: string[] = [`# ${heading}`, "", watchUrl(videoId), ""];

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
