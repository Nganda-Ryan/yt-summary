import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "./options.css";

const KEY_STORAGE = "apiKey";
const PROVIDER_STORAGE = "provider";

type Provider = "auto" | "anthropic" | "gemini";

const PROVIDER_LABELS: Record<Provider, string> = {
  auto: "Détection automatique",
  anthropic: "Anthropic (Claude)",
  gemini: "Google (Gemini)",
};

const PLACEHOLDERS: Record<Provider, string> = {
  auto: "sk-ant-… ou AIza…",
  anthropic: "sk-ant-…",
  gemini: "AIza…",
};

function mask(key: string): string {
  if (key.length <= 8) return "••••••";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function Options() {
  const [value, setValue] = useState("");
  const [provider, setProvider] = useState<Provider>("auto");
  const [stored, setStored] = useState<string | null>(null);
  const [storedProvider, setStoredProvider] = useState<Provider>("auto");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    chrome.storage.local
      .get([KEY_STORAGE, PROVIDER_STORAGE])
      .then((result: Record<string, unknown>) => {
        if (cancelled) return;
        const key = result[KEY_STORAGE];
        if (typeof key === "string" && key) setStored(mask(key));
        const chosen = result[PROVIDER_STORAGE];
        if (chosen === "anthropic" || chosen === "gemini") {
          setStoredProvider(chosen);
          setProvider(chosen);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const key = value.trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
    if (!key) {
      setMessage("Colle une clé Anthropic ou Gemini pour activer le résumé.");
      return;
    }
    let resolved: Provider = provider;
    if (key.startsWith("AIza") || key.startsWith("AQ.")) resolved = "gemini";
    else if (key.startsWith("sk-ant-")) resolved = "anthropic";
    await chrome.storage.local.set({ [KEY_STORAGE]: key, [PROVIDER_STORAGE]: resolved });
    setStored(mask(key));
    setStoredProvider(resolved);
    setProvider(resolved);
    setValue("");
    setMessage("Clé enregistrée.");
  };

  return (
    <main className="page">
      <h1>YouTube Transcript Panel</h1>

      <section>
        <h2>Clé API — Anthropic ou Gemini</h2>
        <p>
          Le bouton « Résumer » utilise l'API Claude d'Anthropic ou l'API Gemini de Google.
          Colle ta clé ci-dessous : elle est conservée dans <code>chrome.storage.local</code>{" "}
          sur <strong>ton</strong> poste, jamais dans le dépôt, et elle n'est jamais lue par le
          contenu de la page — seul le service worker de l'extension la récupère.
        </p>

        <form onSubmit={save}>
          <label htmlFor="provider">Fournisseur</label>
          <select
            id="provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value as Provider)}
          >
            {(Object.keys(PROVIDER_LABELS) as Provider[]).map((option) => (
              <option key={option} value={option}>
                {PROVIDER_LABELS[option]}
              </option>
            ))}
          </select>

          <label htmlFor="api-key">Clé API</label>
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={PLACEHOLDERS[provider]}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="submit">Enregistrer</button>
        </form>

        <p className="help">
          Où obtenir une clé :{" "}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            console.anthropic.com
          </a>{" "}
          (commence par <code>sk-ant-</code>) ou{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            aistudio.google.com
          </a>{" "}
          (commence par <code>AIza</code>). En mode « Détection automatique », le fournisseur est
          choisi d'après ce préfixe.
        </p>

        {stored && (
          <p className="stored">
            Clé actuellement enregistrée : {stored} ({PROVIDER_LABELS[storedProvider]})
          </p>
        )}
        {message && <p className="message">{message}</p>}
      </section>

      <section>
        <h2>Sans clé</h2>
        <p>
          Tout le reste fonctionne sans clé : transcription horodatée, clic sur les segments,
          exports <code>.pdf</code>, <code>.srt</code> et <code>.md</code>. Seul le résumé reste désactivé.
        </p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Options />);
