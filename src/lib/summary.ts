import { formatClock } from "./format";

export interface SummarySection {
  /** Rapproché d'un vrai début de segment, en secondes. */
  start: number;
  title: string;
  summary: string;
}

export interface SummaryResult {
  kind: VideoKind;
  essence: string;
  sections: SummarySection[];
}

export const VIDEO_KINDS = ["tutorial", "news", "lecture", "interview", "review", "other"] as const;
export type VideoKind = (typeof VIDEO_KINDS)[number];

export const VIDEO_KIND_LABELS: Record<VideoKind, string> = {
  tutorial: "Tutoriel",
  news: "Actu",
  lecture: "Cours",
  interview: "Interview",
  review: "Revue",
  other: "Autre",
};

export const DEFAULT_VIDEO_KIND: VideoKind = "other";

export function parseVideoKind(value: unknown): VideoKind {
  return typeof value === "string" && (VIDEO_KINDS as readonly string[]).includes(value)
    ? (value as VideoKind)
    : DEFAULT_VIDEO_KIND;
}

export interface TranscriptAnchor {
  start: number;
  text: string;
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
  return lines
    .map((line) => `[${formatClock(line.start)} | ${Math.round(line.start)}s] ${line.text}`)
    .join("\n");
}

const KIND_GUIDE = [
  "Déduis le type UNIQUEMENT d'après ce qui est dit (le titre n'est qu'un indice faible).",
  "kind doit être l'une des valeurs : tutorial, news, lecture, interview, review, other.",
  "Puis applique les règles du type choisi :",
  "- tutorial (procédure / tuto) : essence = résultat + chemin le plus court. Chaque section = UNE étape, title = l'action, summary = comment faire + valeurs/commandes dites + résultat attendu.",
  "- news (journal / actu) : essence = faits qui changent quelque chose. Chaque section = UN fait (qui / quoi / quand / combien). Pas de « le présentateur explique ».",
  "- lecture (cours / notion) : essence = définition + intuition. Sections : concept → mécanisme → exemple → piège. Pour réviser, pas pour raconter le cours.",
  "- interview : essence = thèse principale. Chaque section = thèse, preuve ou phrase à retenir, attribuée si plusieurs voix.",
  "- review (test / comparatif) : essence = verdict net. Chaque section = critère, chiffre, pour/contre ou verdict.",
  "- other : quintessence actionnable, points qui changent une décision.",
].join("\n");

export function buildPrompt(transcript: string, language: string, options: { title: string }): string {
  const title = options.title.trim() || "(sans titre)";
  return [
    "Tu reçois la transcription horodatée d'une vidéo YouTube.",
    "Chaque ligne commence par [mm:ss | Ns] : copie N dans start_seconds.",
    `Titre de la vidéo (indice seulement) : ${title}`,
    "",
    "Réponds UNIQUEMENT avec un objet JSON valide, sans balises Markdown ni texte autour :",
    '{"kind":"tutorial","essence":"Digest de 2 à 4 phrases","sections":[{"start_seconds":12,"quote":"huit à douze mots copiés","title":"Titre","summary":"Contenu utile"}]}',
    "",
    "Mission : faire gagner du temps. Le lecteur doit pouvoir arriver à la solution sans revoir la vidéo,",
    "et un clic sur une section doit tomber AU DÉBUT du moment où l'idée est dite.",
    "",
    "Règles communes :",
    `- Réponds en ${language}.`,
    "- essence : 2 à 4 phrases denses. Pas de formule creuse.",
    "- start_seconds : l'entier N de la ligne où l'idée COMMENCE (pas le milieu, pas un rappel plus tard).",
    "- quote : 8 à 12 mots consécutifs COPIÉS tels quels de cette même ligne, au tout début de l'idée.",
    "- title : 3 à 10 mots, concrets.",
    "- summary : 1 à 4 phrases, fidèles au dit, avec chiffres / noms / commandes quand ils sont dans la vidéo.",
    "- Range les sections par ordre chronologique, sans chevauchement ni trou inutile.",
    "- Donne entre 4 et 12 sections selon la densité réelle (moins si la vidéo est courte ou creuse).",
    "- N'invente rien qui ne soit pas dans la transcription.",
    "- Ignore intro, CTA, « like / abonne-toi », blagues, teasers, pubs, répétitions.",
    "",
    KIND_GUIDE,
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
    kind: {
      type: "STRING",
      enum: ["tutorial", "news", "lecture", "interview", "review", "other"],
    },
    essence: { type: "STRING" },
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          start_seconds: { type: "NUMBER" },
          quote: { type: "STRING" },
          title: { type: "STRING" },
          summary: { type: "STRING" },
        },
        required: ["start_seconds", "quote", "title", "summary"],
      },
    },
  },
  required: ["kind", "essence", "sections"],
} as const;

/** Récupère le premier objet JSON d'une réponse éventuellement entourée de texte. */
function extractJsonObject(raw: string): string {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("aucun objet JSON dans la réponse");
  return cleaned.slice(start, end + 1);
}

function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function parseStartSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const asNumber = Number(trimmed.replace(/s$/i, ""));
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;
  const clock = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!clock) return null;
  const hours = clock[1] ? Number(clock[1]) : 0;
  return hours * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
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

/** Trouve le début du segment qui contient la citation, dans le flux de la transcription. */
export function locateQuote(
  quote: string,
  segments: ReadonlyArray<TranscriptAnchor>,
): number | null {
  const variants = quoteVariants(quote);
  if (variants.length === 0) return null;

  const parts: Array<{ start: number; from: number; to: number }> = [];
  let corpus = "";
  for (const segment of segments) {
    const piece = normalizeForMatch(segment.text);
    if (!piece) continue;
    if (corpus.length > 0) corpus += " ";
    const from = corpus.length;
    corpus += piece;
    parts.push({ start: segment.start, from, to: corpus.length });
  }
  if (!corpus) return null;

  for (const needle of variants) {
    const at = corpus.indexOf(needle);
    if (at === -1) continue;
    const hit = parts.find((part) => at >= part.from && at < part.to);
    if (hit) return hit.start;
  }
  return null;
}

function quoteVariants(quote: string): string[] {
  const full = normalizeForMatch(quote);
  if (full.length < 6) return [];
  const words = full.split(/\s+/).filter(Boolean);
  const variants = [full];
  if (words.length > 8) variants.push(words.slice(0, 8).join(" "));
  if (words.length > 5) variants.push(words.slice(0, 5).join(" "));
  return variants.filter((item, index, all) => item.length >= 6 && all.indexOf(item) === index);
}

function locateByKeywords(
  title: string,
  summary: string,
  claimed: number,
  segments: ReadonlyArray<TranscriptAnchor>,
): number | null {
  const tokens = normalizeForMatch(`${title} ${summary}`)
    .split(/\s+/)
    .filter((token) => token.length >= 5);
  if (tokens.length === 0 || segments.length === 0) return null;

  const unique = [...new Set(tokens)].slice(0, 8);
  const windowStart = claimed - 25;
  const windowEnd = claimed + 45;
  let bestStart: number | null = null;
  let bestScore = 1;

  for (const segment of segments) {
    if (segment.start < windowStart || segment.start > windowEnd) continue;
    const hay = normalizeForMatch(segment.text);
    const score = unique.reduce((sum, token) => sum + (hay.includes(token) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestStart = segment.start;
    }
  }
  return bestStart;
}

function alignTimestamp(
  claimed: number,
  quote: string,
  title: string,
  summary: string,
  segments: ReadonlyArray<TranscriptAnchor>,
): number {
  const fromQuote = locateQuote(quote, segments);
  if (fromQuote !== null) return fromQuote;
  const fromWords = locateByKeywords(title, summary, claimed, segments);
  if (fromWords !== null) return fromWords;
  return snapToNearest(claimed, segments.map((segment) => segment.start));
}

/**
 * Valide la réponse du modèle : format attendu, horodatages calés sur
 * une citation réelle, sections triées. Sans cette validation, un minutage
 * inventé mènerait à un endroit faux de la vidéo.
 */
export function parseSummary(raw: string, segments: ReadonlyArray<TranscriptAnchor>): SummaryResult {
  let data: unknown;
  try {
    data = JSON.parse(extractJsonObject(raw));
  } catch {
    throw new Error("réponse du modèle illisible (JSON invalide)");
  }

  const record =
    data && typeof data === "object"
      ? (data as { kind?: unknown; essence?: unknown; sections?: unknown })
      : null;
  const sections = Array.isArray(data) ? data : (record?.sections ?? null);
  if (!Array.isArray(sections)) {
    throw new Error("réponse du modèle : clé « sections » absente");
  }

  const essence = record && typeof record.essence === "string" ? record.essence.trim() : "";
  const kind = parseVideoKind(record?.kind);

  const validated: SummarySection[] = [];
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const item = section as {
      start_seconds?: unknown;
      quote?: unknown;
      title?: unknown;
      summary?: unknown;
    };
    const claimed = parseStartSeconds(item.start_seconds);
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    const quote = typeof item.quote === "string" ? item.quote.trim() : "";
    if (claimed === null || !title || !summary) continue;
    validated.push({
      start: alignTimestamp(claimed, quote, title, summary, segments),
      title,
      summary,
    });
  }

  if (validated.length === 0) throw new Error("aucune section valide dans la réponse");
  validated.sort((a, b) => a.start - b.start);
  return { kind, essence, sections: validated };
}
