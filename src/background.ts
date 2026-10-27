import {
  MAX_SUMMARY_SECONDS,
  SUMMARY_RESPONSE_SCHEMA,
  buildPrompt,
  buildTranscriptLines,
  formatLines,
  parseSummary,
  type SummarySection,
} from "./lib/summary";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = "claude-sonnet-5-5";
const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-3.8-flash",
];
const MAX_TOKENS = 2048;
const GEMINI_TIMEOUT_MS = 20000;

type Provider = "anthropic" | "gemini";

interface RequestSegment {
  start: number;
  text: string;
}

type IncomingMessage =
  | { type: "hasKey" }
  | { type: "openOptions" }
  | { type: "summarize"; duration: number; segments: RequestSegment[] };

type ResponsePayload =
  | { ok: true }
  | { ok: true; hasKey: boolean }
  | { ok: true; sections: SummarySection[] }
  | { ok: false; code?: "no_key" | "too_long"; error: string };

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const incoming = message as IncomingMessage;
  if (!incoming || typeof incoming !== "object") return false;
  if (incoming.type !== "hasKey" && incoming.type !== "summarize" && incoming.type !== "openOptions") {
    return false;
  }

  handle(incoming)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  // réponse asynchrone : on garde le canal ouvert
  return true;
});

async function handle(message: IncomingMessage): Promise<ResponsePayload> {
  if (message.type === "hasKey") {
    return { ok: true, hasKey: (await readKeyConfig()) !== null };
  }
  if (message.type === "openOptions") {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  return summarize(message);
}

function sanitizeApiKey(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function providerFromKey(key: string): Provider | null {
  if (key.startsWith("AIza") || key.startsWith("AQ.")) return "gemini";
  if (key.startsWith("sk-ant-")) return "anthropic";
  return null;
}

/**
 * Clé et fournisseur choisis dans les options. Le préfixe de la clé
 * (AIza / sk-ant-) l'emporte sur un fournisseur mal sélectionné.
 */
async function readKeyConfig(): Promise<{ apiKey: string; provider: Provider } | null> {
  const stored = await chrome.storage.local.get(["apiKey", "provider"]);
  const apiKey: unknown = stored.apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) return null;

  const key = sanitizeApiKey(apiKey);
  if (!key) return null;

  const fromKey = providerFromKey(key);
  const chosen: unknown = stored.provider;
  const provider: Provider =
    fromKey ??
    (chosen === "anthropic" || chosen === "gemini" ? chosen : "anthropic");
  return { apiKey: key, provider };
}

async function summarize(message: Extract<IncomingMessage, { type: "summarize" }>): Promise<ResponsePayload> {
  const config = await readKeyConfig();
  if (!config) {
    return { ok: false, code: "no_key", error: "Aucune clé API configurée." };
  }
  if (message.duration > MAX_SUMMARY_SECONDS) {
    const minutes = Math.round(MAX_SUMMARY_SECONDS / 60);
    return {
      ok: false,
      code: "too_long",
      error: `Vidéo trop longue pour être résumée (${minutes} minutes maximum).`,
    };
  }

  const segments = message.segments.filter(
    (segment) => Number.isFinite(segment.start) && typeof segment.text === "string" && segment.text.trim().length > 0,
  );
  if (segments.length === 0) {
    return { ok: false, error: "Transcription vide." };
  }

  const lines = buildTranscriptLines(segments, bucketSeconds(message.duration));
  const prompt = buildPrompt(formatLines(lines), "français");

  const result =
    config.provider === "gemini"
      ? await callGemini(config.apiKey, prompt)
      : await callAnthropic(config.apiKey, prompt);
  if (!result.ok) return result;

  if (!result.text.trim()) return { ok: false, error: "Réponse vide du modèle." };

  const anchors = segments.map((segment) => segment.start);
  return { ok: true, sections: parseSummary(result.text, anchors) };
}

function bucketSeconds(duration: number): number {
  if (duration > 45 * 60) return 45;
  if (duration > 20 * 60) return 30;
  return 15;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(apiKey: string, prompt: string): Promise<
  { ok: true; text: string } | { ok: false; error: string }
> {
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const payload = (await response.json().catch(() => null)) as {
    content?: Array<{ type?: string; text?: string }>;
    error?: { message?: string };
  } | null;

  if (!response.ok) {
    const message = payload?.error?.message ?? `Erreur Anthropic (HTTP ${response.status}).`;
    if (/invalid x-api-key/i.test(message)) {
      return {
        ok: false,
        error:
          "Clé Anthropic invalide. Une clé Gemini (AIza…) doit être utilisée avec le fournisseur Google, " +
          "une clé Claude commence par sk-ant-. Recolle la bonne clé dans les options.",
      };
    }
    return { ok: false, error: message };
  }

  const text = (payload?.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  return { ok: true, text };
}

async function callGemini(apiKey: string, prompt: string): Promise<
  { ok: true; text: string } | { ok: false; error: string }
> {
  let lastError = "Erreur Gemini.";
  for (const model of GEMINI_MODELS) {
    const result = await callGeminiModel(apiKey, prompt, model);
    if (result.ok) return result;
    lastError = result.error;
    if (!result.retryable) return result;
  }
  return { ok: false, error: lastError };
}

function isGeminiOverloaded(status: number, message: string): boolean {
  if (status === 429 || status === 503 || status === 404) return true;
  return /high demand|try again later|overloaded|unavailable|no longer available|not found|resource exhausted|quota/i.test(
    message,
  );
}

async function callGeminiModel(
  apiKey: string,
  prompt: string,
  model: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string; retryable: boolean }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: MAX_TOKENS,
            responseMimeType: "application/json",
            responseSchema: SUMMARY_RESPONSE_SCHEMA,
          },
        }),
      },
      GEMINI_TIMEOUT_MS,
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `Délai dépassé (${model}).` : error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }

  const payload = (await response.json().catch(() => null)) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    promptFeedback?: { blockReason?: string };
    error?: { message?: string };
  } | null;

  if (!response.ok) {
    const message = payload?.error?.message ?? `Erreur Gemini (HTTP ${response.status}).`;
    return { ok: false, error: message, retryable: isGeminiOverloaded(response.status, message) };
  }

  const blockReason = payload?.promptFeedback?.blockReason;
  if (blockReason) {
    return { ok: false, error: `Réponse bloquée par Gemini (${blockReason}).`, retryable: false };
  }

  const text = (payload?.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return { ok: true, text };
}
