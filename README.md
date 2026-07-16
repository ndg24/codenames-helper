# Codenames Clue Assistant

A Codenames clue generator that ranks candidate clues by semantic coverage of your team's words versus risk to the opponent, neutral words, and the assassin — computed entirely client-side with a local sentence-embedding model.

## Overview

Coming up with a good Codenames clue means balancing two things at once: how many of your team's words a clue connects to, and how close it drifts to a word that would hand the other team a free guess or end the game outright. This project automates that tradeoff. It embeds a 1,200-word vocabulary and the board's words with a local sentence-transformer, scores every candidate clue by (coverage of your team's words) minus (weighted similarity to danger words), and returns a ranked list — all in-browser, with no API calls and no cost per query.

## Features

- **Local embedding inference** — `Xenova/all-MiniLM-L6-v2` (a Hugging Face sentence-transformer, ONNX-quantized) runs via WASM in the browser through `@xenova/transformers`, so board words are embedded live with no server round-trip.
- **Precomputed candidate vocabulary** — the ~1,200-word clue bank is embedded once offline by a Node script and shipped as a static JSON file, so the browser only ever embeds the 25 live board words, not the whole vocabulary.
- **Coverage-vs-risk scoring** — for each candidate and each possible clue count (2–4; single-word clues are never generated), the ranker averages similarity to the best-matching own-team words, subtracts the weighted max similarity to any opponent/neutral/assassin word (assassin weighted highest), and adds a small per-word bonus for counts above 1 (since a plain average of sorted similarities can never favor a higher count on its own — it rewards the turn-saving compression of a multi-word clue, capped by a minimum-similarity floor so a barely-related word can't be padded in just to inflate the count; a candidate whose 2nd-best word is too weak is dropped rather than offered as a single-word clue). Keeps each candidate's best-scoring count.
- **Deterministic legality filter** — any candidate that exactly matches, contains, or is contained in a board word is excluded outright, enforcing Codenames' clue-legality rule without relying on the model to remember it.
- **Turn tracking** — tap a word on the clue screen (or its reveal toggle on the board) once it's guessed; revealed cards drop out of coverage/risk scoring and clues recompute automatically. A remaining-word tally per color and an endgame banner (assassin hit / team fully cleared) track game state without a page reload.
- **Optional Gemini generation pass** — "Ask Gemini for clues" sends the full board (your words, opponent's, neutral, and the assassin) to Gemini (free tier) and lets it invent up to 5 clues from its own vocabulary and reasoning, rather than re-ranking the Stage 1 shortlist — this is what catches puns, categories, and cultural connections that MiniLM embeddings miss. Fully optional: the offline embedding results are already usable on their own, and any failure (no API key configured, request error, malformed response, all picks failing the legality check) falls back to the Stage 1 list with an inline message rather than blocking the UI.
- **Photo/screenshot board capture** — upload, drag-drop, or paste a photo of the physical board (or a screenshot); Claude's vision reads the 25 words via forced tool-use output and hands back a checklist to confirm/correct before continuing. Colors are never read from the photo — that stays on the existing manual dot-tap UI (see Architecture). Falls back cleanly to manual entry on any failure (no API key configured, unreadable image, request error).
- **Wordbank-assisted OCR correction** — before the confirm screen renders, each vision-read word is compared against the ~1,200-word bank by edit distance; if exactly one bank entry is closest within a small, length-scaled distance threshold, the word is snapped to it and flagged with a small blue dot (editing that cell afterward clears the flag). A tie between two equally-close bank words, or no match within threshold, leaves Claude's raw read untouched.
- **Guesser mode** — a Spymaster/Guesser toggle on the capture screen switches the app to the other side of the table: type or photograph the 25 words as usual, but skip color assignment entirely (a real guesser never knows the colors) and land on a dedicated screen instead. Enter the clue and count you were given and it ranks every unrevealed word by cosine similarity to the clue — the same embedding engine as clue generation, pointed in reverse. Tapping a word to mark it guessed re-filters the ranked list instantly from cached embeddings, no re-run of the model.

## Architecture & Design Decisions

- **Client-side embeddings over a hosted API** — the whole scoring loop runs in the browser via transformers.js instead of calling out to a hosted embedding API. This keeps every clue-generation request free and instant, at the cost of a one-time ~90MB model-weight download on first use (cached by the browser afterward).
- **No bundler** — transformers.js is loaded straight from a CDN via a native `<script type="module">` import rather than through Vite/webpack. The app ships as plain static files (HTML/CSS/JS), which keeps deployment to "upload the folder" with no build step. The tradeoff is no bundling/minification, which doesn't matter much at this file count.
- **Precompute the vocabulary, embed the board live** — embedding all 1,200 candidate words in-browser on every page load would be slow and wasteful, so that's done once offline (`scripts/embed-wordbank.mjs`) and checked in as `data/word-vectors.json`. Only the 25 board words are embedded at runtime, keeping "Get Clues" fast.
- **Hard-coded legality filter over trusting the model** — MiniLM has no notion of Codenames' rules, so substring/superstring/exact-match legality is enforced as a deterministic string check rather than left to embedding similarity or an LLM to catch. The same `isLegal` check is re-applied server-side to every clue Gemini invents — since Gemini generates the clue word freely (only its `targets` list is enum-constrained to your team's actual remaining words), its word choice is never trusted on faith.
- **Simple, auditable scoring over a black-box ranker** — the score is a plain weighted difference (own-word coverage minus danger similarity) instead of a trained ranking model, so the risk note shown for every clue ("closest risk: X (color, sim 0.XX)") is a direct, explainable readout of the same math that produced the ranking.
- **Gemini over Claude for Stage 2** — the plan originally called for Claude, but Gemini's free tier is a better fit for a low-volume personal tool: no per-call cost, and its `responseSchema` support lets the target-word enum constraint live directly in the API contract rather than in prompt text alone.
- **Generation guardrails, defense in depth** — API key stays server-side only (`.env`, never sent to the browser); the request body is capped to 50KB to bound cost; a 20s timeout plus single retry on 5xx (not on 4xx, which won't fix itself); the model's response is schema-validated, every clue is re-checked against the same legality filter, single-word format is enforced, and any target word it didn't actually offer (or that isn't currently one of your team's remaining words) is dropped — on any failure, the endpoint returns `{ok:false, reason}` (never a 500 for expected failure modes) so the client falls back to the Stage 1 list instead of breaking the flow.
- **Snap-correct OCR misreads only when unambiguous** — `src/ocrCorrect.mjs` compares each vision-read word against the wordbank by Levenshtein distance and only auto-corrects when exactly one bank entry is closest within threshold. A silent correction to the wrong word is a worse failure than an uncorrected typo the user can still see and fix on the confirm screen, so a tie between equally-close candidates is left alone rather than resolved by guessing.
- **Guesser mode never reads word color, even when it's available** — `rankGuesses` in `src/scoring.mjs` only compares the clue vector against board-word vectors; it has no `color` parameter at all. This is deliberate: a real guesser doesn't know colors, so the ranking can't lean on information the person using it wouldn't actually have, even if the same device previously ran a Spymaster session with colors assigned.

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla JS (ES modules), HTML5, CSS3 — no framework, no bundler |
| ML / Inference | `@xenova/transformers` (transformers.js) running `Xenova/all-MiniLM-L6-v2`; WASM in-browser, `onnxruntime-node` for offline precomputation |
| Backend | Minimal — `scripts/serve.mjs` adds one route, `POST /api/refine-clues`, calling the Gemini API server-side |
| Infra / Deploy | Static hosting (GitHub Pages / Vercel / Netlify / Cloudflare Pages); zero-dependency Node static server for local dev |
| Testing | Node's built-in test runner (`node:test`) for unit tests, Playwright for an e2e smoke test |

## Getting Started

### Prerequisites

- Node >= 18

### Installation

```bash
git clone https://github.com/ndg24/codenames-helper.git
cd codenames-helper
npm install
```

### Configuration

No environment variables or API keys are required for the core app — it runs fully offline/client-side.

The optional "Ask Gemini for clues" pass needs a free Gemini API key:

```bash
cp .env.example .env
# then fill in GEMINI_API_KEY from https://aistudio.google.com/apikey
```

Without a key, the "Ask Gemini for clues" button still shows but falls back to the offline Stage 1 list with an inline message — nothing else in the app is affected.

### Run

```bash
npm run embed-wordbank   # one-time: builds data/word-vectors.json from wordbank.txt
npm run serve            # serves the app at http://localhost:8080
```

## Testing

Two tiers:

- **Unit tests** (`npm test`) — pure-math tests against `src/scoring.mjs` using `node:test`: legality filtering, danger-weighting order (assassin > opponent > neutral), best-count selection (minimum 2 words, never falls back to a single-word clue), and ranking/sorting. Also covers `server/refineClues.mjs`'s guardrails (missing API key, not enough own words remaining, illegal/hallucinated-target/multi-word picks dropped, target-count capping, retry-on-5xx-not-4xx, malformed JSON) and `server/parseBoard.mjs`'s vision-call handling (retry/error paths, word normalization, OCR-correction wiring) with a mocked `fetch` — no real Gemini/Anthropic calls or network access needed. `src/ocrCorrect.mjs` has its own tests for the correction/ambiguity logic in isolation. Fast, no network, no model weights involved.
- **E2E smoke test** (`npm run test:e2e`) — Playwright drives a real browser against a running `npm run serve` instance: fills a 25-word board, clicks "Get clues," waits for the model to load and results to render, checks the console for errors, and confirms board state survives navigating back. Requires network access (fetches the model from the CDN on first run) and a one-time `npx playwright install chromium`.

Run both before every deploy:

```bash
npm test
npm run serve &          # or in a separate terminal
npm run test:e2e
```

## Deployment

The frontend (`index.html`, `app.js`, `styles.css`, `data/word-vectors.json`) is still fully static and works on any static host with zero build step. The one piece of server-side code is the `/api/refine-clues` route in `scripts/serve.mjs`, which only matters if you want the Gemini generation pass to work in production too.

- **Static-only (Gemini generation disabled)** — GitHub Pages / Vercel / Netlify / Cloudflare Pages, framework preset "Other"/static, no build command, output directory `/`. The "Ask Gemini for clues" button will just fall back to the offline list.
- **With Gemini generation** — deploy `scripts/serve.mjs` somewhere that can run a small Node process (or port the single `/api/refine-clues` handler to your platform's serverless function format) and set `GEMINI_API_KEY` in that environment.

## Roadmap

- E2E test coverage for the photo-capture flow (capture → confirm → board) and for Guesser mode, alongside the existing manual-entry smoke test.
- Deployment config (Vercel/Netlify) for the `/api/parse-board` and `/api/refine-clues` routes.
- Shareable board link so a teammate can view/update the same board state from their own device.
