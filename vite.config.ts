import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    // Noms de fichiers stables : un build ne change plus les noms, donc
    // l'extension déjà chargée dans Chrome reste valable après un rebuild
    // (sinon le manifest en mémoire référence d'anciens hashes et Chrome
    // bloque le chargement : « Unsafe attempt to load URL … »).
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
