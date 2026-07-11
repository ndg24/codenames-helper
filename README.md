# Codenames Clue Assistant

A Codenames clue generator that ranks candidate clues by semantic coverage of your team's words versus risk to the opponent, neutral words, and the assassin — computed entirely client-side with a local sentence-embedding model.

## Overview

Coming up with a good Codenames clue means balancing two things at once: how many of your team's words a clue connects to, and how close it drifts to a word that would hand the other team a free guess or end the game outright. This project automates that tradeoff. It embeds a 1,200-word vocabulary and the board's words with a local sentence-transformer, scores every candidate clue by (coverage of your team's words) minus (weighted similarity to danger words), and returns a ranked list — all in-browser, with no API calls and no cost per query.

## Features

- **Local embedding inference** — `Xenova/all-MiniLM-L6-v2` (a Hugging Face sentence-transformer, ONNX-quantized) runs via WASM in the browser through `@xenova/transformers`, so board words are embedded live with no server round-trip.
- **Precomputed candidate vocabulary** — the ~1,200-word clue bank is embedded once offline by a Node script and shipped as a static JSON file, so the browser only ever embeds the 25 live board words, not the whole vocabulary.
- **Coverage-vs-risk scoring** — for each candidate and each possible clue count (1–4), the ranker averages similarity to the best-matching own-team words and subtracts the weighted max similarity to any opponent/neutral/assassin word (assassin weighted highest), then keeps each candidate's best-scoring count.
- **Deterministic legality filter** — any candidate that exactly matches, contains, or is contained in a board word is excluded outright, enforcing Codenames' clue-legality rule without relying on the model to remember it.
- **Turn tracking** — tap a word on the clue screen (or its reveal toggle on the board) once it's guessed; revealed cards drop out of coverage/risk scoring and clues recompute automatically. A remaining-word tally per color and an endgame banner (assassin hit / team fully cleared) track game state without a page reload.

## Architecture & Design Decisions

- **Client-side embeddings over a hosted API** — the whole scoring loop runs in the browser via transformers.js instead of calling out to a hosted embedding API. This keeps every clue-generation request free and instant, at the cost of a one-time ~90MB model-weight download on first use (cached by the browser afterward).
- **No bundler** — transformers.js is loaded straight from a CDN via a native `<script type="module">` import rather than through Vite/webpack. The app ships as plain static files (HTML/CSS/JS), which keeps deployment to "upload the folder" with no build step. The tradeoff is no bundling/minification, which doesn't matter much at this file count.
- **Precompute the vocabulary, embed the board live** — embedding all 1,200 candidate words in-browser on every page load would be slow and wasteful, so that's done once offline (`scripts/embed-wordbank.mjs`) and checked in as `data/word-vectors.json`. Only the 25 board words are embedded at runtime, keeping "Get Clues" fast.
- **Hard-coded legality filter over trusting the model** — MiniLM has no notion of Codenames' rules, so substring/superstring/exact-match legality is enforced as a deterministic string check rather than left to embedding similarity or a future LLM pass to catch.
- **Simple, auditable scoring over a black-box ranker** — the score is a plain weighted difference (own-word coverage minus danger similarity) instead of a trained ranking model, so the risk note shown for every clue ("closest risk: X (color, sim 0.XX)") is a direct, explainable readout of the same math that produced the ranking.

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla JS (ES modules), HTML5, CSS3 — no framework, no bundler |
| ML / Inference | `@xenova/transformers` (transformers.js) running `Xenova/all-MiniLM-L6-v2`; WASM in-browser, `onnxruntime-node` for offline precomputation |
| Backend | None — fully static site |
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

No environment variables or API keys are required — the app runs fully offline/client-side.

### Run

```bash
npm run embed-wordbank   # one-time: builds data/word-vectors.json from wordbank.txt
npm run serve            # serves the app at http://localhost:8080
```

## Testing

Two tiers:

- **Unit tests** (`npm test`) — pure-math tests against `src/scoring.mjs` using `node:test`: legality filtering, danger-weighting order (assassin > opponent > neutral), best-count selection, and ranking/sorting. Fast, no network, no model weights involved.
- **E2E smoke test** (`npm run test:e2e`) — Playwright drives a real browser against a running `npm run serve` instance: fills a 25-word board, clicks "Get clues," waits for the model to load and results to render, checks the console for errors, and confirms board state survives navigating back. Requires network access (fetches the model from the CDN on first run) and a one-time `npx playwright install chromium`.

Run both before every deploy:

```bash
npm test
npm run serve &          # or in a separate terminal
npm run test:e2e
```

## Deployment

The app is fully static (`index.html`, `app.js`, `styles.css`, `data/word-vectors.json`) — there's no server-side code to deploy, so any static host works. `data/word-vectors.json` must be committed/deployed alongside the rest (it's the precomputed vocabulary; run `npm run embed-wordbank` again only if `wordbank.txt` changes).

- **GitHub Pages** — push to `main`, enable Pages in repo settings pointing at the root, done.
- **Vercel / Netlify** — import the repo, framework preset "Other"/static, no build command, output directory `/`.
- **Cloudflare Pages** — same as above: no build step, deploy the repo root directly.

## Roadmap

- Claude-based Stage 2 refinement pass: legality double-check + plain-English risk explanations for the top candidates.
- Photo/screenshot board capture via Claude vision, replacing manual entry as the default input path.
