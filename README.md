![Démo de l'extension](assets/demo.gif)

_Annexe : enregistre la démo dans `assets/demo.gif` avant de publier (Étape 9 du guide)._

# YouTube Transcript Panel

Extension Chrome (Manifest V3) qui injecte un panneau de transcription **directement dans la page YouTube** :
aucun serveur, aucune iframe, la vraie `<video>` est pilotée.

- transcription horodatée avec **clic vers la vidéo** et segment courant surligné (défilement automatique),
- **résumé par idées** avec Claude **ou Gemini** : chaque section est cliquable et renvoie au bon endroit de la vidéo,
- **exports** `.txt` et `.srt` + copie dans le presse-papiers,
- fonctionne **sans clé API** : seul le résumé est désactivé.

## Installation (3 étapes)

```bash
git clone <ton-dépôt> yt-transcript-panel
cd yt-transcript-panel
npm i && npm run build
```

Puis dans Chrome : `chrome://extensions` → activer le **mode développeur** → **Charger l'extension
non empaquetée** → choisir le dossier `dist`.

## Obtenir la clé API

Le résumé fonctionne avec **l'un ou l'autre** fournisseur :

1. Crée une clé :
   - Anthropic : <https://console.anthropic.com> → **API Keys** → **Create Key** (commence par `sk-ant-`),
   - Google Gemini : <https://aistudio.google.com/apikey> (commence par `AIza`).
2. Dans `chrome://extensions`, clique sur **Détails** de l'extension → **Extension options**
   (page d'options) → choisis le fournisseur (ou laisse la **détection automatique**, qui
   devine d'après le préfixe de la clé) → colle la clé → **Enregistrer**.

La clé est stockée dans `chrome.storage.local` : elle n'est **pas chiffrée**, reste sur ton poste et
n'est jamais lue par le contenu de la page — seul le service worker de l'extension la récupère.
**Aucune clé n'est présente dans ce dépôt** ; chacun met la sienne dans son extension.

Sans clé, la transcription, les clics, la copie et les exports fonctionnent normalement ; seul le
bouton « Résumer » est grisé, avec un lien vers la page d'options.

## Comment ça marche

Le panneau est injecté dans un **Shadow DOM** (styles isolés de YouTube) et suit les navigations
SPA (`yt-navigate-finish`). La transcription est récupérée par trois méthodes, dans cet ordre :

1. la piste de sous-titres déclarée dans le HTML de la page (`fmt=json3`),
2. le panneau « Transcription » natif de YouTube, ouvert automatiquement au besoin puis
   refermé après lecture (pour ne pas superposer deux boîtes de transcription),
3. l'endpoint interne `youtubei/v1/get_transcript`.

Le résumé part au service worker (`src/background.ts`), qui appelle l'API Anthropic
(`claude-sonnet-5-5`) ou l'API Gemini (`gemini-3.8-flash`, avec repli automatique si le modèle est saturé, sortie structurée JSON) selon le
fournisseur configuré, puis **valide la
réponse** : chaque `start_seconds` est ramené au segment réel le plus proche, les sections sont
triées et les entrées invalides écartées — sans cela, un minutage inventé mènerait au mauvais endroit.

## Limites connues

- **L'extraction peut casser** : YouTube change régulièrement ses endpoints. Si aucune des trois
  méthodes ne renvoie de texte, ouvre le panneau « Transcription » natif (méthode 2 s'exécute alors
  sur le DOM déjà rempli) et signale l'erreur affichée.
- Les vidéos de plus de **2 h** sont refusées pour le résumé (pas encore de découpage en tranches).
- Panneau **flottant** en haut à droite : il n'est pas encore inséré dans la colonne `#secondary`.
- Sous-titres privilégiés : `fr` puis `en`, sinon la première piste disponible.
- Pages `/shorts` et `/live` non gérées (panneau masqué hors `/watch`).
- Le résumé envoie le texte horodaté de la vidéo à l'API Anthropic ou à l'API Gemini.

## Tests

- Dernier test : **24 octobre 2026**, vidéo `dQw4w9WgXcQ` (vidéo récente à vérifier de ton côté).
- Vérifié : `npm run build` (typecheck + bundle) et 24 tests unitaires de
  `lib/summary.ts` / `lib/format.ts` (horodatages, regroupement en blocs de 15 s, validation du JSON,
  exports `.txt`/`.srt`, schéma de sortie Gemini).
- Vérifié aussi : parsing du HTML de YouTube en conditions réelles (pistes de sous-titres et paramètres
  innertube bien extraits).
- **Non vérifié ici** : le téléchargement de la piste `json3` (corps vide depuis un client HTTP nu) et
  `get_transcript` (HTTP 400 `failedPrecondition`) — YouTube exige le contexte d'un vrai navigateur.
  À revalider dans Chrome : `chrome://extensions` → charger `dist` → ouvrir une vidéo avec sous-titres.
