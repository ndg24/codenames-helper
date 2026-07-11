# Codenames Clue Assistant — Full Build Plan

## What it does

You photograph or screenshot the board, the app reads the words and colors, you confirm/correct them, then it suggests ranked clues for your team — with word counts and a note on why each is safe or risky. Your existing word list (`wordbank.txt`, at the project root) powers a free, instant, offline first pass; Claude handles the harder parts (reading photos, sanity-checking legality, explaining risk in plain English).

## Architecture (two-stage clue engine)

**Stage 1 — Embeddings (Hugging Face model, free, offline, instant)**
Use `Xenova/all-MiniLM-L6-v2` — a Hugging Face sentence-transformer model ported to run in-browser via **transformers.js**. It embeds every word into a vector; cosine similarity between vectors approximates semantic relatedness. This runs entirely client-side (WASM), no server, no API key, no per-call cost.

- On first load, embed every word in `wordbank.txt` once and cache the vectors (localStorage or a static JSON file you generate ahead of time).
- When a board loads, embed the 25 board words too.
- For every candidate word in your list, score it: high average similarity to your team's unrevealed words, low similarity to opponent words/neutrals, near-zero similarity to the assassin. Rank candidates by (words covered × safety margin).
- This gives you a ranked shortlist in milliseconds, no API cost, works even offline.

**Stage 2 — Claude refinement (optional, costs a few cents/call)**
Take the top ~10 embedding candidates and send them to Claude with the board state, asking it to: drop anything that's actually illegal (substring/superstring of a board word, too obscure), pick the best 3–5, and write a one-line human-readable risk explanation for each. This is the step that turns "mathematically similar" into "an actual good clue a human would give."

**Vision parsing (Claude, required for the photo step)**
Hugging Face doesn't have anything as convenient as Claude's vision + structured-output combo for reading a photographed board layout and colors, so keep that call on Claude. This is the only other place a real API call happens.

**Why split it this way:** the embeddings stage means you can get clue suggestions completely free, offline, and instantly, and only spend API calls on the two things that actually need a strong reasoning/vision model — reading photos and sanity-checking output.

## Handling wordbank.txt

Lives at the project root, one word per line, loaded at build/setup time. Ingestion:
1. Read `wordbank.txt`, split on newlines, trim whitespace, dedupe, lowercase for matching (keep original casing for display).
2. Run each word through the embedding model once, offline, and save the resulting vectors to a JSON file (e.g. `word-vectors.json`) checked into the project — this avoids re-embedding thousands of words every time someone opens the app.
3. At runtime, only the ~25 board words need fresh embedding (cheap, instant); the precomputed `wordbank.txt` vectors are just loaded.
4. Reuse `wordbank.txt` for OCR correction: when Claude's vision step reads a word off a photo, snap it to the nearest Levenshtein/embedding match in the bank rather than trusting raw text.

## Fallback when a word isn't in the bank

Two different situations need this, and they're handled differently:

- **Board word doesn't need to be in the bank at all.** The board words (read off the photo) get embedded live by the same HF model at runtime — MiniLM can embed any string, not just ones pre-cached in `wordbank.txt`. So an unusual board word with no match in the bank still scores fine against Stage 1; nothing breaks.
- **OCR-correction fallback is the real risk case.** When Claude's vision step misreads a word, you snap it to the nearest match in your bank by edit-distance/embedding similarity. If the *actual* word isn't in your bank at all, the nearest "match" could be a completely unrelated word — a bad silent correction. Fix: set a similarity/edit-distance threshold. Above it, auto-apply the correction. Below it, don't force a correction — fall back to trusting Claude's raw vision output as-is (it already read the image directly, so it's a better source of truth than a forced snap to an unrelated bank word). You can optionally re-ask Claude to double check that specific cell if you want a second opinion.
- **Thin candidate coverage fallback.** If you ever restrict *candidate clue words* to only what's in your bank (rather than anything MiniLM can embed) and the bank comes back with nothing good for a given board word, fall back to asking Claude directly for clue ideas for that word — same as the Stage 2 refinement call, just triggered automatically instead of only on request.

Net effect: the bank is a fast/free layer, Claude vision is the fallback whenever confidence drops, and correctness never depends on your list being complete.

## Frontend

Single-page web app, plain HTML/CSS/JS or lightweight React. transformers.js runs fine in a regular browser tab — no native app or GPU needed. Screens: capture → confirm words → (confirm colors) → clue results → play/reveal tracking.

## UI design system

Visual direction: dark "ops dashboard" aesthetic — calm, modular, premium, not flashy. Key tokens to carry through every screen:

- **Background**: very dark navy, `#0B1223` (not true black).
- **Card surface**: slightly lighter navy, `#131C30`, thin low-contrast border (`rgba(255,255,255,0.06)`), 18–24px radius.
- **Accent**: electric blue `#5B8CFF`, used sparingly — active states, borders on the current step, progress bars, the primary button.
- **Secondary accent**: muted gold, warning/risk indicators only (e.g. a clue that's flagged as risky).
- **Text**: white primary, muted gray secondary (`#9AA7C3`) for metadata/help text.
- **Typography**: Inter/system sans; large bold headings (40–52px), small uppercase tracked section labels ("BOARD CAPTURE", "CONFIRM WORDS"), 18–22px body.
- **Buttons**: primary = bright/high-contrast, rounded 12–16px; secondary = dark surface, thin border, subtle hover lift. No heavy shadows.
- **Motion**: fast (150–250ms) fades/border-glow/slight translateY only — no bounce, no big scale changes.
- **Avoid**: gradients, glassmorphism, oversized icons, heavy shadows, bright backgrounds, playful colors.

Applies to every screen: capture, word-confirmation checklist, color tagging, clue results list, and turn tracker. The confirm-words screen in particular should read like a checklist/log (rounded list rows, current/editable row gets the blue border + brighter text, per the list styling in this system) rather than a table.

## Backend

Minimal — you only need a server for the two Claude calls (vision parsing + refinement), since those require a hidden API key. A single small serverless function (Vercel or Cloudflare Worker) with two routes:
- `POST /parse-board` — image in, structured JSON board out.
- `POST /refine-clues` — board state + embedding candidates in, ranked final clues with explanations out.

No database needed. No persistent Python server needed, since the ML model runs client-side via transformers.js rather than through a Python ML library.

## Data model

```
Card: { id, word, color: "blue" | "red" | "neutral" | "assassin", revealed: boolean }
Board: { cards: Card[25], yourTeam: "blue" | "red" }
ClueCandidate: { clue: string, count: number, targetCardIds: string[], score: number }   // from embeddings stage
ClueSuggestion: { clue: string, count: number, targetCardIds: string[], reasoning: string, riskNotes: string }  // after Claude refinement
```

## Flow

1. **Capture** — upload a photo or paste a screenshot of the board.
2. **Parse** — Claude vision call returns just the 25 words it read (word-only pass, no color yet).
3. **Confirm words** — show the returned list to the user as a plain checklist: "here's what I read." If it's correct, they confirm and move on. If anything's wrong, they edit that word inline (no need to redo the whole capture) — this is a distinct, required gate before anything downstream runs.
4. **Assign colors** — once words are confirmed, either the same vision pass supplies color per word (shown for a second quick confirm), or the user tags colors manually if you'd rather keep color assignment fully separate from OCR.
5. **Score candidates** — transformers.js embeds the confirmed board words, compares against your cached vocabulary vectors, returns a ranked shortlist instantly, for free.
6. **Refine (optional)** — send the top candidates to Claude for a legality check and plain-English risk notes; toggle this off if you want a fully free/offline run.
7. **Play** — tap words to mark revealed; remaining-word lists update automatically for the next clue round.

Splitting steps 2/3 (words only) from step 4 (colors) matters: word-reading errors and color-reading errors have different causes (OCR misread vs. lighting/glare on the tile color) and separating the confirmation gates means a user isn't stuck re-checking 25 colors just because one word had a typo.

## MVP vs later

**MVP (build this first):**
- Manual board entry (type the 25 words, tap to assign colors) — no photo pipeline yet, removes vision accuracy as a variable.
- `wordbank.txt` ingestion + embedding cache script.
- Embeddings-only clue scoring (Stage 1) wired to a "Get Clues" button — this alone is a usable, free tool.

**Phase 2:**
- Claude refinement pass (Stage 2) for legality-checking and readable explanations.
- Photo/screenshot upload with Claude vision parsing, replacing manual entry as the default.
- Turn tracking polish (auto-recompute remaining words as cards are revealed).

**Phase 3:**
- "Guesser mode" — paste a clue you were given, get ranked guesses from the remaining board (same embeddings engine, reversed).
- Shareable game link so a teammate can view the same board state on their phone.
- Support for Duet/other Codenames variants.

## Known risks

- **Vision accuracy**: glare, angle, and card-color variation across editions can cause misreads — hence the mandatory confirm/correct step.
- **Embedding quality**: MiniLM is a general-purpose model, not Codenames-tuned — it'll sometimes miss cultural/wordplay connections (puns, compound words) a human or Claude would catch. That's exactly what the Stage 2 refinement pass is for.
- **API cost/latency**: only two call types (vision parse, refinement) cost anything — a few cents and a couple seconds each. Stage 1 scoring is free and instant, so you're not paying for every idea you look at.
- **Color ambiguity**: different Codenames editions use different color schemes — confirm which team is yours and the color key rather than assuming.
- **Codenames legality rule**: a clue can't be a board word or share a root with one (e.g. "SNOWMAN" can't clue "SNOW"). Enforce this in code (string-matching check) as a hard filter, don't rely on the model to always remember it.

## Suggested build order

1. Write a standalone script: load `wordbank.txt` from the project root, embed every word with `Xenova/all-MiniLM-L6-v2`, save vectors to `word-vectors.json`. Sanity-check by hand (e.g. confirm "OCEAN" scores high against "FISH", low against "STAMP").
2. Build the core scoring function: given a board state + cached vectors, output ranked clue candidates. Test via a script/CLI before touching any UI.
3. Build manual board-entry frontend (grid, color tagging) wired to the scoring function running in-browser — this is a usable free MVP with zero backend.
4. Add the serverless `/refine-clues` endpoint calling Claude; wire a toggle in the UI to call it on the top candidates.
5. Add the serverless `/parse-board` endpoint (Claude vision) and photo upload UI, pre-filling the manual-entry grid instead of typing from scratch.
6. Turn tracking, polish, deploy, test with a real game.
