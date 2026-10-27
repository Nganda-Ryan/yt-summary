import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTranscript, type Segment, type TranscriptSource } from "../lib/transcript";
import {
  formatClock,
  highlightQuery,
  matchQuery,
  toMarkdown,
  toPlainText,
  toSrt,
  toSummaryPlainText,
} from "../lib/format";
import { documentToPdf } from "../lib/pdf";
import {
  VIDEO_KIND_LABELS,
  type SummarySection,
  type VideoKind,
} from "../lib/summary";

type Status = "idle" | "loading" | "ready" | "error";
type SummaryStatus = "idle" | "loading" | "error";

interface SummarizeResponse {
  ok?: boolean;
  kind?: VideoKind;
  essence?: string;
  sections?: SummarySection[];
  error?: string;
}

const SOURCE_LABELS: Record<TranscriptSource, string> = {
  captions: "sous-titres YouTube",
  youtubei: "API interne YouTube",
  dom: "panneau natif",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function watchIdFromLocation(): string | null {
  if (location.pathname !== "/watch") return null;
  return new URLSearchParams(location.search).get("v");
}

function watchIdFromEvent(event?: Event): string | undefined {
  if (!event) return undefined;
  const detail = (event as CustomEvent<Record<string, unknown> | undefined>).detail;
  if (!detail || typeof detail !== "object") return undefined;

  const endpoint = detail.endpoint as Record<string, unknown> | undefined;
  const videoId = (endpoint?.watchEndpoint as { videoId?: unknown } | undefined)?.videoId;
  if (typeof videoId === "string" && videoId) return videoId;

  const metadata = endpoint?.commandMetadata as { webCommandMetadata?: { url?: unknown } } | undefined;
  const rawUrl = (typeof detail.url === "string" ? detail.url : null) ?? metadata?.webCommandMetadata?.url;
  if (typeof rawUrl !== "string") return undefined;
  try {
    const parsed = new URL(rawUrl, location.origin);
    if (parsed.pathname === "/watch") return parsed.searchParams.get("v") ?? undefined;
  } catch {
    return undefined;
  }
  return undefined;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const parts = highlightQuery(text, query);
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="ytp-mark">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

export default function Panel() {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const requestRef = useRef(0);
  const videoIdRef = useRef<string | null>(null);
  const flashTimerRef = useRef<number | undefined>(undefined);

  const [videoId, setVideoId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [source, setSource] = useState<TranscriptSource | null>(null);
  const [summary, setSummary] = useState<SummarySection[]>([]);
  const [essence, setEssence] = useState("");
  const [summaryKind, setSummaryKind] = useState<VideoKind | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>("idle");
  const [summaryError, setSummaryError] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [flash, setFlash] = useState("");
  const [query, setQuery] = useState("");

  const showFlash = useCallback((message: string) => {
    setFlash(message);
    window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlash(""), 2500);
  }, []);

  const load = useCallback(async (id: string) => {
    const token = requestRef.current + 1;
    requestRef.current = token;
    setStatus("loading");
    setError("");
    setSegments([]);
    setSource(null);
    setSummary([]);
    setEssence("");
    setSummaryKind(null);
    setSummaryStatus("idle");
    setSummaryError("");
    setCurrentTime(0);
    setQuery("");
    try {
      const transcript = await fetchTranscript(id);
      if (requestRef.current !== token) return;
      setSegments(transcript.segments);
      setSource(transcript.source);
      setStatus("ready");
    } catch (cause) {
      if (requestRef.current !== token) return;
      setError(errorMessage(cause));
      setStatus("error");
    }
  }, []);

  const applyLocation = useCallback((event?: Event) => {
    const id = watchIdFromEvent(event) ?? watchIdFromLocation();

    if (!id) {
      requestRef.current += 1;
      videoIdRef.current = null;
      setVideoId(null);
      setSegments([]);
      setStatus("idle");
      setSummary([]);
      setEssence("");
      setSummaryKind(null);
      setQuery("");
      return;
    }
    if (id !== videoIdRef.current) {
      videoIdRef.current = id;
      setVideoId(id);
      void load(id);
    }
  }, [load]);

  useEffect(() => {
    const onNavigate = (event: Event) => applyLocation(event);
    const pageEvents = ["yt-navigate-start", "yt-navigate-finish", "yt-page-data-updated"] as const;
    for (const eventName of pageEvents) {
      document.addEventListener(eventName, onNavigate);
    }
    window.addEventListener("popstate", onNavigate);
    const interval = window.setInterval(() => applyLocation(), 400);
    applyLocation();
    return () => {
      for (const eventName of pageEvents) {
        document.removeEventListener(eventName, onNavigate);
      }
      window.removeEventListener("popstate", onNavigate);
      window.clearInterval(interval);
    };
  }, [applyLocation]);

  useEffect(() => {
    let cancelled = false;
    chrome.runtime
      .sendMessage({ type: "hasKey" })
      .then((response: { ok?: boolean; hasKey?: boolean } | undefined) => {
        if (!cancelled && response?.ok) setHasKey(Boolean(response.hasKey));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  /** Suit la lecture : l'élément <video> peut être recréé à chaque navigation. */
  useEffect(() => {
    if (!videoId) return;
    let video: HTMLVideoElement | null = null;
    const onTimeUpdate = () => {
      if (video) setCurrentTime(video.currentTime);
    };
    const bind = () => {
      const found = document.querySelector<HTMLVideoElement>("video");
      if (found === video) return;
      video?.removeEventListener("timeupdate", onTimeUpdate);
      video = found;
      video?.addEventListener("timeupdate", onTimeUpdate);
      if (video) setCurrentTime(video.currentTime);
    };
    bind();
    const interval = window.setInterval(bind, 1000);
    return () => {
      window.clearInterval(interval);
      video?.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [videoId]);

  const searching = query.trim().length > 0;

  const activeIndex = useMemo(() => {
    let index = -1;
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i].start > currentTime + 0.2) break;
      index = i;
    }
    return index;
  }, [segments, currentTime]);

  const activeSummaryIndex = useMemo(() => {
    let index = -1;
    for (let i = 0; i < summary.length; i += 1) {
      if (summary[i].start > currentTime + 0.2) break;
      index = i;
    }
    return index;
  }, [summary, currentTime]);

  const ready = status === "ready" && segments.length > 0;
  const summaryMode = ready && summary.length > 0;

  const visibleSegments = useMemo(() => {
    return segments.flatMap((segment, index) =>
      matchQuery(segment.text, query) ? [{ segment, index }] : [],
    );
  }, [segments, query]);

  const visibleSections = useMemo(() => {
    return summary.flatMap((section, index) =>
      matchQuery(`${section.title} ${section.summary}`, query) ? [{ section, index }] : [],
    );
  }, [summary, query]);

  /* Garde le segment ou l'idée courant visible, comme les paroles sur Spotify. */
  useEffect(() => {
    if (searching) return;
    const container = listRef.current;
    const index = summaryMode ? activeSummaryIndex : activeIndex;
    if (!container || index < 0) return;
    const row = container.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!row) return;
    const target = row.offsetTop - container.clientHeight / 2 + row.offsetHeight / 2;
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [activeIndex, activeSummaryIndex, summaryMode, searching]);

  const goTo = useCallback((seconds: number) => {
    const video = document.querySelector<HTMLVideoElement>("video");
    if (!video) {
      showFlash("Aucune vidéo trouvée sur la page");
      return;
    }
    video.currentTime = seconds;
    void video.play().catch(() => undefined);
  }, [showFlash]);

  const summarize = useCallback(async () => {
    if (!videoId || segments.length === 0) return;
    setSummaryStatus("loading");
    setSummaryError("");
    const video = document.querySelector<HTMLVideoElement>("video");
    const last = segments[segments.length - 1];
    const duration = video && Number.isFinite(video.duration) ? video.duration : last.start + last.duration;
    const pageTitle = document.title.replace(/\s*-\s*YouTube$/, "");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "summarize",
        duration,
        title: pageTitle,
        segments: segments.map((segment) => ({ start: segment.start, text: segment.text })),
      }) as SummarizeResponse | undefined;
      if (!response) {
        setSummaryStatus("error");
        setSummaryError("Le service worker n'a pas répondu.");
        return;
      }
      if (!response.ok || !response.sections?.length) {
        setSummaryStatus("error");
        setSummaryError(response.error ?? "Erreur inconnue pendant le résumé.");
        return;
      }
      setSummary(response.sections);
      setEssence(response.essence?.trim() ?? "");
      setSummaryKind(response.kind && VIDEO_KIND_LABELS[response.kind] ? response.kind : null);
      setSummaryStatus("idle");
    } catch (cause) {
      setSummaryStatus("error");
      setSummaryError(errorMessage(cause));
    }
  }, [segments, videoId]);

  const download = useCallback(
    (filename: string, data: string | Uint8Array, mime = "text/plain;charset=utf-8") => {
      let blob: Blob;
      if (typeof data === "string") {
        blob = new Blob([data], { type: mime });
      } else {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        blob = new Blob([copy.buffer as ArrayBuffer], { type: mime });
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showFlash(`Fichier ${filename} téléchargé`);
    },
    [showFlash],
  );

  const copyTranscript = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(toPlainText(segments));
      showFlash("Transcription copiée");
    } catch {
      showFlash("Copie impossible");
    }
  }, [segments, showFlash]);

  const copySummary = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(toSummaryPlainText(summary, essence));
      showFlash("Résumé copié");
    } catch {
      showFlash("Copie impossible");
    }
  }, [summary, essence, showFlash]);

  const openOptions = useCallback(() => {
    chrome.runtime
      .sendMessage({ type: "openOptions" })
      .catch(() => showFlash("Impossible d'ouvrir les options"));
  }, [showFlash]);

  const closeSummary = useCallback(() => {
    setSummary([]);
    setEssence("");
    setSummaryKind(null);
  }, []);

  const title = document.title.replace(/\s*-\s*YouTube$/, "");
  const hitCount = summaryMode ? visibleSections.length : visibleSegments.length;

  /* Hors d'une page /watch, le panneau disparaît complètement. */
  if (!videoId) return null;

  return (
    <div className="ytp-panel" ref={rootRef}>
      <header className="ytp-header">
        <div className="ytp-heading">
          <span className="ytp-title" title={title}>
            {title}
          </span>
          <span className="ytp-meta">
            {summaryMode
              ? `${summary.length} ${summaryKind ? VIDEO_KIND_LABELS[summaryKind].toLowerCase() : "idées"}`
              : ready
                ? `${segments.length} segments · ${source ? SOURCE_LABELS[source] : ""}`
                : "Transcription"}
          </span>
        </div>
        <button
          type="button"
          className="ytp-icon-btn"
          title={collapsed ? "Développer le panneau" : "Réduire le panneau"}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? "＋" : "－"}
        </button>
      </header>

      {!collapsed && (
        <div className="ytp-body">
          {ready && (
            <div className="ytp-search">
              <input
                type="search"
                className="ytp-search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={summaryMode ? "Rechercher dans le résumé…" : "Rechercher dans les sous-titres…"}
                aria-label={summaryMode ? "Rechercher dans le résumé" : "Rechercher dans les sous-titres"}
              />
              {searching && (
                <span className="ytp-search-count">
                  {hitCount} résultat{hitCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
          )}

          {status === "loading" && <p className="ytp-status">Chargement de la transcription…</p>}

          {status === "error" && (
            <div className="ytp-error">
              <p>{error}</p>
              {videoId && (
                <button type="button" className="ytp-btn" onClick={() => void load(videoId)}>
                  Réessayer
                </button>
              )}
            </div>
          )}

          {summaryMode && (
            <section className="ytp-summary">
              <div className="ytp-summary-head">
                <h2>
                  {summaryKind ? VIDEO_KIND_LABELS[summaryKind] : "Résumé"}
                </h2>
                <button
                  type="button"
                  className="ytp-icon-btn"
                  title="Revenir à la transcription"
                  onClick={closeSummary}
                >
                  ×
                </button>
              </div>
              {essence && !searching && <p className="ytp-essence">{essence}</p>}
              {searching && visibleSections.length === 0 ? (
                <p className="ytp-empty">Aucun résultat</p>
              ) : (
                <ul className="ytp-summary-list" ref={(node) => { listRef.current = node; }}>
                  {visibleSections.map(({ section, index }) => (
                    <li key={`${section.start}-${index}`} data-index={index}>
                      <button
                        type="button"
                        className={index === activeSummaryIndex ? "ytp-section is-active" : "ytp-section"}
                        onClick={() => goTo(section.start)}
                      >
                        <span className="ytp-section-time">[{formatClock(section.start)}]</span>
                        <strong className="ytp-section-title">
                          <HighlightedText text={section.title} query={query} />
                        </strong>
                        <span className="ytp-section-summary">
                          <HighlightedText text={section.summary} query={query} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {ready && !summaryMode && (
            searching && visibleSegments.length === 0 ? (
              <p className="ytp-empty">Aucun résultat</p>
            ) : (
              <div className="ytp-list" ref={(node) => { listRef.current = node; }}>
                {visibleSegments.map(({ segment, index }) => (
                  <button
                    type="button"
                    key={`${segment.start}-${index}`}
                    data-index={index}
                    className={index === activeIndex ? "ytp-seg is-active" : "ytp-seg"}
                    onClick={() => goTo(segment.start)}
                  >
                    <span className="ytp-time">{formatClock(segment.start)}</span>
                    <span className="ytp-text">
                      <HighlightedText text={segment.text} query={query} />
                    </span>
                  </button>
                ))}
              </div>
            )
          )}

          <footer className="ytp-footer">
            <div className="ytp-actions">
              {summaryMode ? (
                <>
                  <button
                    type="button"
                    className="ytp-btn"
                    onClick={() => void copySummary()}
                  >
                    Copier
                  </button>
                  <button
                    type="button"
                    className="ytp-btn"
                    onClick={() =>
                      download(
                        `resume-${videoId}.pdf`,
                        documentToPdf({
                          title,
                          videoId,
                          heading: summaryKind ? `Résumé · ${VIDEO_KIND_LABELS[summaryKind]}` : "Résumé par idées",
                          essence,
                          items: summary.map((section) => ({
                            start: section.start,
                            title: section.title,
                            text: section.summary,
                          })),
                        }),
                        "application/pdf",
                      )
                    }
                  >
                    .pdf
                  </button>
                  <button
                    type="button"
                    className="ytp-btn"
                    onClick={() =>
                      download(
                        `resume-${videoId}.md`,
                        toMarkdown({
                          title,
                          videoId,
                          segments,
                          sections: summary,
                          essence,
                          includeTranscript: false,
                        }),
                      )
                    }
                  >
                    .md
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ytp-btn ytp-btn-primary"
                    disabled={!ready || !hasKey || summaryStatus === "loading"}
                    onClick={() => void summarize()}
                  >
                    {summaryStatus === "loading" ? "Résumé en cours…" : "Résumer"}
                  </button>
                  <button
                    type="button"
                    className="ytp-btn"
                    disabled={!ready}
                    onClick={() => void copyTranscript()}
                  >
                    Copier
                  </button>
                  <button
                    type="button"
                    className="ytp-btn"
                    disabled={!ready}
                    onClick={() =>
                      download(
                        `transcript-${videoId}.pdf`,
                        documentToPdf({
                          title,
                          videoId,
                          heading: "Transcription",
                          items: segments.map((segment) => ({
                            start: segment.start,
                            text: segment.text,
                          })),
                        }),
                        "application/pdf",
                      )
                    }
                  >
                    .pdf
                  </button>
                  <button
                    type="button"
                    className="ytp-btn"
                    disabled={!ready}
                    onClick={() => download(`transcript-${videoId}.srt`, toSrt(segments))}
                  >
                    .srt
                  </button>
                  <button
                    type="button"
                    className="ytp-btn"
                    disabled={!ready}
                    onClick={() =>
                      download(
                        `transcript-${videoId}.md`,
                        toMarkdown({ title, videoId, segments, sections: summary, essence }),
                      )
                    }
                  >
                    .md
                  </button>
                </>
              )}
            </div>

            {!summaryMode && summaryStatus === "error" && <p className="ytp-error-text">{summaryError}</p>}

            {!summaryMode && !hasKey && (
              <p className="ytp-hint">
                Le résumé nécessite une clé Anthropic ou Gemini.{" "}
                <button type="button" className="ytp-link" onClick={openOptions}>
                  Ouvrir les options
                </button>
              </p>
            )}

            {flash && <p className="ytp-flash">{flash}</p>}
          </footer>
        </div>
      )}
    </div>
  );
}
