export interface Segment {
  /** Début du segment, en secondes. */
  start: number;
  /** Durée du segment, en secondes. */
  duration: number;
  /** Texte du segment. */
  text: string;
}

export type TranscriptSource = "captions" | "youtubei" | "dom";

export interface Transcript {
  videoId: string;
  source: TranscriptSource;
  language: string;
  segments: Segment[];
}

const PREFERRED_LANGUAGES = ["fr", "en"];

const INNERTUBE_FALLBACK_CONTEXT = {
  client: {
    clientName: "WEB",
    clientVersion: "2.20240101.00.00",
  },
};

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
}

/**
 * Extrait la transcription de la vidéo en essayant les trois méthodes connues :
 * 1. la piste de sous-titres (HTML, timedtext de la vidéo courante, client Android),
 * 2. l'endpoint interne youtubei/v1/get_transcript,
 * 3. le panneau « Transcription » natif, masqué, en dernier recours.
 */
export async function fetchTranscript(videoId: string): Promise<Transcript> {
  const html = await fetchWatchPage(videoId);
  const attempts: Array<[TranscriptSource, () => Promise<Transcript>]> = [
    ["captions", () => fromCaptionTracks(videoId, html)],
    ["youtubei", () => fromInnertube(videoId, html)],
    ["dom", () => fromOpenPanelDom(videoId)],
  ];

  const errors: string[] = [];
  for (const [source, run] of attempts) {
    try {
      const transcript = await run();
      if (transcript.segments.length > 0) return transcript;
      errors.push(`${source} : réponse vide`);
    } catch (error) {
      errors.push(`${source} : ${errorMessage(error)}`);
    }
  }

  throw new Error(
    `Aucune transcription récupérée (${errors.join(" · ")}). ` +
      "Ouvre le panneau « Transcription » natif de YouTube, puis réessaie.",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchWatchPage(videoId: string): Promise<string> {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`page watch HTTP ${response.status}`);
  return response.text();
}

/**
 * Extrait le tableau/objet JSON qui suit un marqueur dans du texte.
 * Le parcours caractère par caractère ignore les crochets contenus dans
 * les chaînes (les URL de sous-titres en contiennent).
 */
function extractJsonAfter(source: string, marker: string): string | null {
  const at = source.indexOf(marker);
  if (at === -1) return null;

  let i = at + marker.length;
  while (i < source.length && /\s/.test(source[i])) i += 1;

  const open = source[i];
  if (open !== "[" && open !== "{") return null;
  const close = open === "[" ? "]" : "}";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < source.length; j += 1) {
    const char = source[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return source.slice(i, j + 1);
    }
  }
  return null;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function segmentsFrom(items: Segment[]): Segment[] {
  const cleaned = items
    .filter((item) => Number.isFinite(item.start) && item.text.length > 0)
    .sort((a, b) => a.start - b.start);

  const deduped: Segment[] = [];
  for (const segment of cleaned) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.start === segment.start && previous.text === segment.text) {
      continue;
    }
    deduped.push(segment);
  }
  return deduped;
}

/* ------------------------------------------------------------------ */
/* Méthode 1 : pistes de sous-titres → téléchargement json3            */
/* ------------------------------------------------------------------ */

async function fromCaptionTracks(videoId: string, html: string): Promise<Transcript> {
  const raw = extractJsonAfter(html, '"captionTracks":');
  if (!raw) throw new Error("aucune piste de sous-titre dans la page");

  let tracks: CaptionTrack[];
  try {
    tracks = JSON.parse(raw) as CaptionTrack[];
  } catch {
    throw new Error("liste des pistes illisible");
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error("liste des pistes vide");
  }

  const track =
    PREFERRED_LANGUAGES.map((lang) =>
      tracks.find((candidate) => candidate.languageCode === lang),
    ).find((candidate) => candidate !== undefined) ?? tracks[0];
  if (!track?.baseUrl) throw new Error("piste sans URL");

  const captured = await segmentsFromTimedtextUrls(timedtextUrlsFromPlayer(videoId));
  if (captured.length > 0) {
    return {
      videoId,
      source: "captions",
      language: track.languageCode ?? "inconnu",
      segments: segmentsFrom(captured),
    };
  }

  const fromTrack = await segmentsFromCaptionUrl(track.baseUrl);
  if (fromTrack.length > 0) {
    return {
      videoId,
      source: "captions",
      language: track.languageCode ?? "inconnu",
      segments: segmentsFrom(fromTrack),
    };
  }

  const fromAndroid = await segmentsFromAndroidPlayer(videoId, html);
  if (fromAndroid.length > 0) {
    return {
      videoId,
      source: "captions",
      language: track.languageCode ?? "inconnu",
      segments: segmentsFrom(fromAndroid),
    };
  }

  throw new Error("piste vide (jeton YouTube manquant ?)");
}

function timedtextUrlsFromPlayer(videoId: string): string[] {
  return Array.from(
    new Set(
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.includes("/api/timedtext") && timedtextBelongsToVideo(name, videoId)),
    ),
  );
}

function timedtextBelongsToVideo(resourceUrl: string, videoId: string): boolean {
  try {
    return new URL(resourceUrl).searchParams.get("v") === videoId;
  } catch {
    return resourceUrl.includes(`v=${videoId}`);
  }
}

async function segmentsFromTimedtextUrls(urls: string[]): Promise<Segment[]> {
  for (const url of urls) {
    const segments = await segmentsFromCaptionUrl(url);
    if (segments.length > 0) return segments;
  }
  return [];
}

async function segmentsFromCaptionUrl(baseUrl: string): Promise<Segment[]> {
  const json3Url = /[?&]fmt=/.test(baseUrl)
    ? baseUrl
    : `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}fmt=json3`;
  const json3 = await fetchText(json3Url);
  const fromJson = parseJson3Captions(json3);
  if (fromJson.length > 0) return fromJson;

  const xmlUrl = json3Url.replace(/([?&])fmt=[^&]*/, "$1fmt=srv3").replace(/[?&]fmt=srv3$/, "");
  const xml = await fetchText(xmlUrl.includes("fmt=") ? xmlUrl : baseUrl);
  return parseXmlCaptions(xml);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) return "";
  return response.text();
}

function parseJson3Captions(body: string): Segment[] {
  if (!body.trim()) return [];
  try {
    const data = JSON.parse(body) as {
      events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }>;
    };
    return (data.events ?? [])
      .filter((event) => Array.isArray(event.segs) && event.segs.length > 0)
      .map((event) => ({
        start: (event.tStartMs ?? 0) / 1000,
        duration: (event.dDurationMs ?? 0) / 1000,
        text: normalizeText(event.segs!.map((seg) => seg.utf8 ?? "").join("")),
      }));
  } catch {
    return [];
  }
}

function parseXmlCaptions(body: string): Segment[] {
  if (!body.includes("<text")) return [];
  const segments: Segment[] = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const start = Number(/start="([^"]+)"/.exec(match[1])?.[1]);
    const duration = Number(/dur="([^"]+)"/.exec(match[1])?.[1]);
    const text = decodeXml(match[2]);
    if (Number.isFinite(start) && text) {
      segments.push({
        start,
        duration: Number.isFinite(duration) ? duration : 0,
        text,
      });
    }
  }
  return segments;
}

function decodeXml(text: string): string {
  return normalizeText(
    text
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))),
  );
}

async function segmentsFromAndroidPlayer(videoId: string, html: string): Promise<Segment[]> {
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  if (!apiKey) return [];
  try {
    const response = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
          videoId,
        }),
      },
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
    };
    const tracks = payload.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const track =
      PREFERRED_LANGUAGES.map((lang) => tracks.find((candidate) => candidate.languageCode === lang)).find(
        (candidate) => candidate !== undefined,
      ) ?? tracks[0];
    if (!track?.baseUrl) return [];
    return segmentsFromCaptionUrl(track.baseUrl);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Méthode 2 : endpoint interne get_transcript                         */
/* ------------------------------------------------------------------ */

async function fromInnertube(videoId: string, html: string): Promise<Transcript> {
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  if (!apiKey) throw new Error("clé innertube absente de la page");

  const visitorId = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1];
  const contextRaw = extractJsonAfter(html, '"INNERTUBE_CONTEXT":');
  let context = INNERTUBE_FALLBACK_CONTEXT;
  if (contextRaw) {
    try {
      context = JSON.parse(contextRaw);
    } catch {
      /* on garde le contexte par défaut */
    }
  }

  const endpointRaw = extractJsonAfter(html, '"getTranscriptEndpoint":');
  if (!endpointRaw) throw new Error("paramètre get_transcript introuvable");
  let params: string | undefined;
  try {
    params = (JSON.parse(endpointRaw) as { params?: string }).params;
  } catch {
    throw new Error("paramètre get_transcript illisible");
  }
  if (!params) throw new Error("paramètre get_transcript vide");

  const clientVersion =
    (context as { client?: { clientVersion?: string } }).client?.clientVersion ??
    INNERTUBE_FALLBACK_CONTEXT.client.clientVersion;

  const url = `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`;
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-youtube-client-name": "1",
      "x-youtube-client-version": clientVersion,
      "x-goog-visitor-id": visitorId ?? "",
      "x-goog-authuser": "0",
      origin: "https://www.youtube.com",
      referer: `https://www.youtube.com/watch?v=${videoId}`,
    },
    body: JSON.stringify({ context, params }),
  });
  if (!response.ok) throw new Error(`get_transcript HTTP ${response.status}`);

  const payload: unknown = await response.json();
  const segments: Segment[] = [];
  collectTranscriptSegments(payload, segments);

  return {
    videoId,
    source: "youtubei",
    language: PREFERRED_LANGUAGES[0],
    segments: segmentsFrom(segments),
  };
}

/**
 * Parcours récursif de la réponse : la structure exacte de get_transcript
 * change régulièrement, on récupère tous les transcriptSegmentRenderer.
 */
function collectTranscriptSegments(node: unknown, out: Segment[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectTranscriptSegments(item, out);
    return;
  }

  const record = node as Record<string, unknown>;
  const renderer = record.transcriptSegmentRenderer as Record<string, unknown> | undefined;
  if (renderer && typeof renderer === "object") {
    const startMs = Number(renderer.startMs);
    const durationMs = Number(renderer.durationMs);
    const text = snippetText(renderer.snippet);
    if (Number.isFinite(startMs) && text) {
      out.push({
        start: startMs / 1000,
        duration: Number.isFinite(durationMs) ? durationMs / 1000 : 0,
        text,
      });
    }
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") collectTranscriptSegments(value, out);
  }
}

function snippetText(snippet: unknown): string {
  if (!snippet || typeof snippet !== "object") return "";
  const record = snippet as { text?: unknown; runs?: Array<{ text?: unknown }> };
  if (typeof record.text === "string") return normalizeText(record.text);
  if (Array.isArray(record.runs)) {
    return normalizeText(record.runs.map((run) => (typeof run?.text === "string" ? run.text : "")).join(""));
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Méthode 3 : panneau « Transcription » natif (ouvert si besoin)      */
/* ------------------------------------------------------------------ */

/** Ancien Polymer + variante 2026 « In this video » / transcript-segment-view-model. */
const SEGMENT_SELECTOR =
  "ytd-transcript-segment-renderer, transcript-segment-view-model";
const TRANSCRIPT_BUTTON_PATTERN =
  /transcript|transcription|transkript|transcri|afficher la transcription|show transcript|字幕|자막/i;
const TRANSCRIPT_TAB_PATTERN = /transcript|transcription|transkript|字幕|자막/i;
const TIME_LINE_PATTERN = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+([\s\S]+)$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSegmentNodes(): Element[] {
  return Array.from(document.querySelectorAll(SEGMENT_SELECTOR));
}

function isTranscriptButton(button: Element): boolean {
  return (
    TRANSCRIPT_BUTTON_PATTERN.test(button.getAttribute("aria-label") ?? "") ||
    TRANSCRIPT_BUTTON_PATTERN.test(button.textContent ?? "")
  );
}

function clickTranscriptTab(): void {
  const tabs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="tab"], yt-tab-shape, tp-yt-paper-tab'),
  );
  const tab = tabs.find((node) =>
    TRANSCRIPT_TAB_PATTERN.test(`${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`),
  );
  tab?.click();
}

/** Ouvre le panneau YouTube avec ses propres boutons (fiabilité maximale). */
async function openTranscriptPanel(): Promise<boolean> {
  clickTranscriptTab();
  if (readSegmentNodes().length > 0) return true;

  const expander = document.querySelector<HTMLElement>(
    "#description-inline-expander #expand, ytd-watch-metadata #expand, #description #expand, ytd-text-inline-expander #expand",
  );
  if (expander) {
    expander.click();
    await sleep(600);
  }

  const dedicated = document.querySelector<HTMLElement>(
    "ytd-video-description-transcript-section-renderer button",
  );
  const button =
    dedicated ??
    Array.from(document.querySelectorAll<HTMLElement>("button, a, yt-button-shape")).find(isTranscriptButton) ??
    null;
  if (!button) return readSegmentNodes().length > 0;

  button.click();
  clickTranscriptTab();
  return true;
}

async function waitForFreshPanel(staleFirst: string, maxWaitMs = 8000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  let sawEmpty = readSegmentNodes().length === 0;
  while (Date.now() < deadline) {
    const first = normalizeText(readSegmentNodes()[0]?.textContent ?? "");
    if (readSegmentNodes().length === 0) sawEmpty = true;
    else if (first && (sawEmpty || first !== staleFirst)) return true;
    clickTranscriptTab();
    await sleep(250);
  }
  return readSegmentNodes().length > 0 && sawEmpty;
}

function findScrollContainer(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      [
        "ytd-transcript-segment-list-renderer",
        "ytd-transcript-panel-renderer",
        "#segments-container",
        ".ytwTranscriptSegmentListRendererHost",
      ].join(", "),
    ),
  );
  const withSegments = candidates.find((node) => node.querySelector(SEGMENT_SELECTOR));
  if (withSegments && withSegments.scrollHeight > withSegments.clientHeight + 8) return withSegments;
  return candidates.find((node) => node.scrollHeight > node.clientHeight + 8) ?? null;
}

/** YouTube ne rend que les segments visibles : on défile pour tout charger. */
async function loadAllSegments(maxRounds = 40): Promise<void> {
  let lastCount = 0;
  let stableRounds = 0;
  for (let round = 0; round < maxRounds && stableRounds < 3; round += 1) {
    const container = findScrollContainer();
    if (container) container.scrollTop = container.scrollHeight;
    await sleep(150);
    const count = readSegmentNodes().length;
    stableRounds = count === lastCount ? stableRounds + 1 : 0;
    lastCount = count;
  }
  const container = findScrollContainer();
  if (container) container.scrollTop = 0;
}

function stripSpokenTime(text: string, totalSec: number): string {
  const unit = "(?:heures?|hours?|minutes?|secondes?|seconds?)";
  const lead = text.match(new RegExp(`^(\\d+\\s*${unit}(?:\\s*(?:et|and)?\\s*\\d+\\s*${unit})*)`, "i"));
  if (!lead) return text;
  let seconds = 0;
  const parts = lead[1].matchAll(/(\d+)\s*(heures?|hours?|minutes?|secondes?|seconds?)/gi);
  for (const part of parts) {
    const amount = Number(part[1]);
    const name = part[2].toLowerCase();
    if (name.startsWith("heure") || name.startsWith("hour")) seconds += amount * 3600;
    else if (name.startsWith("min")) seconds += amount * 60;
    else seconds += amount;
  }
  return seconds === Math.round(totalSec) ? text.slice(lead[1].length).trim() : text;
}

function readDomSegment(node: Element): Segment | null {
  const timestamp =
    node.querySelector(
      ".segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp",
    )?.textContent ?? "";
  const rawText =
    node.querySelector(".segment-text, .ytAttributedStringHost, .yt-core-attributed-string[role='text']")
      ?.textContent ?? "";
  let time = normalizeText(timestamp);
  let text = normalizeText(rawText);
  if (!text) {
    const full = normalizeText(node.textContent ?? "");
    const match = full.match(TIME_LINE_PATTERN);
    if (match) {
      time = time || match[1];
      text = match[2];
    } else {
      text = full;
    }
  }
  const start = parseTimestamp(time) ?? parseAttributeStart(node);
  if (start === null || !text) return null;
  text = stripSpokenTime(text, start);
  if (!text) return null;
  return { start, duration: 0, text };
}

function collectDomSegments(): Segment[] {
  return readSegmentNodes()
    .map(readDomSegment)
    .filter((segment): segment is Segment => segment !== null);
}

async function fromOpenPanelDom(videoId: string): Promise<Transcript> {
  cloakNativeTranscript();
  const stopHiding = watchAndHideNativePanels();
  try {
    const staleFirst = normalizeText(readSegmentNodes()[0]?.textContent ?? "");
    dismissTranscriptPanel();
    await waitForSegmentsGone();
    revealTranscriptPanel();

    const opened = await openTranscriptPanel();
    if (!opened || !(await waitForFreshPanel(staleFirst))) {
      throw new Error("panneau de transcription introuvable");
    }
    await loadAllSegments();
    const segments = collectDomSegments();
    return {
      videoId,
      source: "dom",
      language: document.documentElement.lang || "inconnu",
      segments: segmentsFrom(segments),
    };
  } finally {
    closeTranscriptPanel();
    await waitForSegmentsGone(800);
    stopHiding();
    uncloakNativeTranscript();
  }
}

const CLOAK_STYLE_ID = "ytp-native-transcript-cloak";
const CLOAK_CSS = `
ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"],
ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"],
ytd-engagement-panel-section-list-renderer[target-id*="transcript" i],
ytd-engagement-panel-section-list-renderer[target-id*="modern" i],
ytd-engagement-panel-section-list-renderer:has(transcript-segment-view-model),
ytd-engagement-panel-section-list-renderer:has(ytd-transcript-segment-renderer),
ytd-engagement-panel-section-list-renderer:has(ytd-transcript-search-panel-renderer),
ytd-engagement-panel-section-list-renderer:has(yt-transcript-search-panel-renderer) {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
  position: fixed !important;
  left: -10000px !important;
  top: 0 !important;
  width: 400px !important;
  height: 80vh !important;
  overflow: auto !important;
  z-index: -1 !important;
}
`;

function cloakNativeTranscript(): void {
  if (document.getElementById(CLOAK_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CLOAK_STYLE_ID;
  style.textContent = CLOAK_CSS;
  document.documentElement.appendChild(style);
}

function uncloakNativeTranscript(): void {
  document.getElementById(CLOAK_STYLE_ID)?.remove();
}

function watchAndHideNativePanels(): () => void {
  let scheduled = false;
  const hide = () => {
    scheduled = false;
    for (const panel of findAllTranscriptPanels()) {
      panel.style.setProperty("opacity", "0", "important");
      panel.style.setProperty("visibility", "hidden", "important");
      panel.style.setProperty("pointer-events", "none", "important");
      panel.style.setProperty("position", "fixed", "important");
      panel.style.setProperty("left", "-10000px", "important");
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(hide);
  };
  hide();
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    hide();
  };
}

async function waitForSegmentsGone(maxWaitMs = 1500): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && readSegmentNodes().length > 0) {
    await sleep(100);
  }
}

const TRANSCRIPT_PANEL_SELECTOR = [
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
  'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]',
  'ytd-engagement-panel-section-list-renderer[target-id*="transcript" i]',
].join(", ");
const PANEL_HIDDEN = "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN";
const CLOSE_LABEL_PATTERN =
  /close|fermer|schließen|cerrar|fechar|chiudi|закрыть|閉じる|닫기|关闭/i;

function looksLikeTranscriptPanel(node: HTMLElement): boolean {
  if (node.querySelector(SEGMENT_SELECTOR)) return true;
  const target = node.getAttribute("target-id") ?? "";
  if (/transcript|modern/i.test(target)) return true;
  const title = node.querySelector("#title-text, #title")?.textContent ?? "";
  return /in this video|dans cette vidéo|transcript|transcription/i.test(title);
}

/** Tous les engagement panels de transcription (YouTube en duplique parfois). */
function findAllTranscriptPanels(): HTMLElement[] {
  const panels = new Set<HTMLElement>();
  for (const node of document.querySelectorAll<HTMLElement>(TRANSCRIPT_PANEL_SELECTOR)) {
    panels.add(node);
  }
  for (const node of document.querySelectorAll<HTMLElement>("ytd-engagement-panel-section-list-renderer")) {
    if (looksLikeTranscriptPanel(node)) panels.add(node);
  }
  for (const node of readSegmentNodes()) {
    const panel = node.closest<HTMLElement>("ytd-engagement-panel-section-list-renderer");
    if (panel) panels.add(panel);
  }
  return Array.from(panels);
}

function nativeCloseButton(panel: HTMLElement): HTMLElement | null {
  const header =
    panel.querySelector<HTMLElement>("ytd-engagement-panel-title-header-renderer") ?? panel;
  const labeled = Array.from(
    header.querySelectorAll<HTMLElement>("button, [role='button'], yt-icon-button"),
  ).find((node) => {
    const label = [
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.textContent,
    ].join(" ");
    return CLOSE_LABEL_PATTERN.test(label);
  });
  if (labeled) return labeled.querySelector("button") ?? labeled;

  const fallback = header.querySelector<HTMLElement>(
    "#visibility-button, #dismiss-button, #close-button, #header-close-button",
  );
  return fallback ? (fallback.querySelector("button") ?? fallback) : null;
}

function hidePanel(panel: HTMLElement): void {
  panel.setAttribute("visibility", PANEL_HIDDEN);
  panel.style.setProperty("display", "none", "important");
}

function askYouTubeToClosePanels(): void {
  const flexy = document.querySelector("ytd-watch-flexy") as {
    closeEngagementPanel?: (id: string) => void;
  } | null;
  const ids = new Set(
    findAllTranscriptPanels()
      .map((panel) => panel.getAttribute("target-id"))
      .filter((id): id is string => Boolean(id)),
  );
  ids.add("engagement-panel-searchable-transcript");
  ids.add("PAmodern_transcript_view");
  for (const id of ids) {
    flexy?.closeEngagementPanel?.(id);
    document.dispatchEvent(
      new CustomEvent("yt-close-engagement-panel", {
        bubbles: true,
        composed: true,
        detail: { panelIdentifier: id },
      }),
    );
  }
}

/** Réaffiche le panneau si on l'avait masqué (à appeler avant de le relire). */
function revealTranscriptPanel(): void {
  for (const panel of findAllTranscriptPanels()) {
    panel.style.removeProperty("display");
  }
}

/** Ferme le panneau YouTube sans display:none, pour pouvoir le rouvrir masqué. */
function dismissTranscriptPanel(): void {
  askYouTubeToClosePanels();
  for (const panel of findAllTranscriptPanels()) {
    nativeCloseButton(panel)?.click();
    panel.setAttribute("visibility", PANEL_HIDDEN);
  }
}

/**
 * Referme le panneau natif après extraction, pour ne superposer que
 * notre panneau. YouTube étiquette le bouton « Fermer » (pas « close »),
 * et l'attribut visibility vaut ENGAGEMENT_PANEL_VISIBILITY_HIDDEN.
 */
function closeTranscriptPanel(): void {
  const panels = findAllTranscriptPanels();
  askYouTubeToClosePanels();
  for (const panel of panels) {
    nativeCloseButton(panel)?.click();
  }

  const hideRemaining = () => {
    let hidWithCss = false;
    for (const panel of findAllTranscriptPanels()) {
      if (!panel.isConnected) continue;
      hidePanel(panel);
      hidWithCss = true;
    }
    if (hidWithCss) ensureRevealOnClick();
  };

  hideRemaining();
  window.setTimeout(hideRemaining, 400);
  window.setTimeout(hideRemaining, 1200);
}

/**
 * Si le repli inline a masqué le panneau, un clic de l'utilisateur sur le
 * bouton natif « Show transcript » doit le réafficher (sinon YouTube devient
 * inutilisable pour qui veut son propre panneau).
 */
let revealListenerInstalled = false;
function ensureRevealOnClick(): void {
  if (revealListenerInstalled) return;
  revealListenerInstalled = true;
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest<HTMLElement>("button, tp-yt-paper-button, ytd-button-renderer");
      if (button && isTranscriptButton(button)) revealTranscriptPanel();
    },
    { capture: true },
  );
}

function parseAttributeStart(node: Element): number | null {
  const raw = node.getAttribute("start-time") ?? node.getAttribute("data-start-time");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? (value > 100000 ? value / 1000 : value) : null;
}

/** « 1:02:03 » ou « 12:34 » → secondes. */
function parseTimestamp(raw: string): number | null {
  const parts = raw.trim().split(":").map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}
