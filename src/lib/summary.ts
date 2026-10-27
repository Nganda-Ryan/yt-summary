import { formatClock } from "./format";

export interface SummarySection {
  /** Rapproché d'un vrai début de segment, en secondes. */
  start: number;
  title: string;
  summary: string;
}

/** Durée maximale acceptée pour un résumé. */
export const MAX_SUMMARY_SECONDS = 2 * 60 * 60;

/** Blocs d'environ 15 secondes envoyés au modèle. */
const BLOCK_SECONDS = 15;

export interface TranscriptLine {
  start: number;
  text: string;
}

export function buildTranscriptLines(
  segments: ReadonlyArray<{ start: number; text: string }>,
  blockSeconds = BLOCK_SECONDS,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let currentBucket = -1;
  for (const segment of segments) {
    const bucket = Math.floor(segment.start / blockSeconds);
    if (bucket !== currentBucket) {
      currentBucket = bucket;
      lines.push({ start: segment.start, text: segment.text });
    } else {
      const last = lines[lines.length - 1];
      last.text = `${last.text} ${segment.text}`.replace(/\s+/g, " ").trim();
    }
  }
  return lines;
}

export function formatLines(lines: TranscriptLine[]): string {
  return lines.map((line) => `[${formatClock(line.start)}] ${line.text}`).join("\n");
}

export function buildPrompt(transcript: string, language: string): string {
  return [
    "Tu reçois la transcription horodatée d'une vidéo YouTube, découpée en blocs d'environ 15 secondes,",
    "chaque ligne commençant par un horodatage au format [mm:ss] ou [h:mm:ss].",
    "",
    "Réponds UNIQUEMENT avec un objet JSON valide, sans balises Markdown ni texte autour :",
    '{"sections":[{"start_seconds":0,"title":"Titre de l\'idée","summary":"Résumé de l\'idée"}]}',
    "",
    "Règles :",
    `- Réponds en ${language}.`,
    "- start_seconds doit être EXACTEMENT l'un des horodatages présents dans la transcription.",
    "- title : 3 à 8 mots qui résument l'idée.",
    "- summary : 1 à 3 phrases, fidèles au contenu dit dans la vidéo.",
    "- Range les sections par ordre chronologique, sans chevauchement ni trou inutile.",
    "- Donne entre 4 et 12 sections selon la durée de la vidéo.",
    "- N'invente rien qui ne soit pas dans la transcription.",
    "",
    "Transcription :",
    transcript,
  ].join("\n");
}

/**
 * Schéma imposé à l'API Gemini (sortie structurée) : même forme que le JSON
 * demandé dans le prompt, pour éviter les réponses approximatives.
 */
export const SUMMARY_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          start_seconds: { type: "NUMBER" },
          title: { type: "STRING" },
          summary: { type: "STRING" },
        },
        required: ["start_seconds", "title", "summary"],
      },
    },
  },
  required: ["sections"],
} as const;

/** Récupère le premier objet JSON d'une réponse éventuellement entourée de texte. */
function extractJsonObject(raw: string): string {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("aucun objet JSON dans la réponse");
  return cleaned.slice(start, end + 1);
}

function snapToNearest(value: number, anchors: number[]): number {
  if (anchors.length === 0) return Math.round(value);
  let best = anchors[0];
  let bestDistance = Math.abs(value - best);
  for (const anchor of anchors) {
    const distance = Math.abs(value - anchor);
    if (distance < bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Valide la réponse du modèle : format attendu, horodatages ramenés aux
 * vrais segments, sections triées. Sans cette validation, un minutage
 * inventé mènerait à un endroit faux de la vidéo.
 */
export function parseSummary(raw: string, anchors: number[]): SummarySection[] {
  let data: unknown;
  try {
    data = JSON.parse(extractJsonObject(raw));
  } catch {
    throw new Error("réponse du modèle illisible (JSON invalide)");
  }

  const sections = Array.isArray(data)
    ? data
    : ((data as { sections?: unknown })?.sections ?? null);
  if (!Array.isArray(sections)) {
    throw new Error("réponse du modèle : clé « sections » absente");
  }

  const validated: SummarySection[] = [];
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const record = section as { start_seconds?: unknown; title?: unknown; summary?: unknown };
    const start = Number(record.start_seconds);
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    if (!Number.isFinite(start) || start < 0 || !title || !summary) continue;
    validated.push({ start: snapToNearest(start, anchors), title, summary });
  }

  if (validated.length === 0) throw new Error("aucune section valide dans la réponse");
  validated.sort((a, b) => a.start - b.start);
  return validated;
}