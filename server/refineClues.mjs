// Stage 2: sends the live board state (all four colors, not just your own words) to
// Gemini and asks it to invent its own clues from scratch, using its own vocabulary and
// reasoning — not a re-ranking of the Stage 1 embedding shortlist. This is what catches
// puns, categories, and cultural connections that MiniLM embeddings miss entirely.
// Server-only module — the API key never reaches the browser.
import { normalizeWord, isLegal } from '../src/scoring.mjs';

const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_PICKS = 5;
const MIN_TARGETS = 2;
const MAX_TARGETS = 4;

function buildPrompt({ board, yourTeam }) {
  const opponentTeam = yourTeam === 'blue' ? 'red' : 'blue';
  const ownWords = board.filter((c) => c.color === yourTeam && !c.revealed).map((c) => c.word);
  const opponentWords = board.filter((c) => c.color === opponentTeam && !c.revealed).map((c) => c.word);
  const neutralWords = board.filter((c) => c.color === 'neutral' && !c.revealed).map((c) => c.word);
  const assassinWords = board.filter((c) => c.color === 'assassin' && !c.revealed).map((c) => c.word);

  return `You are an expert Codenames spymaster giving a clue to your teammate for the "${yourTeam}" team.

Your team's remaining words: ${ownWords.join(', ')}
Opponent's (${opponentTeam}) remaining words: ${opponentWords.join(', ') || '(none)'}
Neutral remaining words: ${neutralWords.join(', ') || '(none)'}
Assassin word(s): ${assassinWords.join(', ') || '(none)'}

Task:
- Invent up to ${MAX_PICKS} one-word clues of your own — a single real English word or well-known proper noun, never a phrase. Do not limit yourself to any pre-existing list; use your own knowledge of wordplay, category, and cultural connections.
- Each clue must connect ${MIN_TARGETS} to ${MAX_TARGETS} of YOUR team's words listed above, with targets listed most-confident first.
- A clue is illegal if it exactly matches, contains, or is contained in ANY word currently on the board, on either team, neutral, or assassin (e.g. "SNOWMAN" can't clue "SNOW"). Never propose an illegal clue.
- Actively steer away from clues that also connect strongly to the assassin word or the opponent's words; call that out in the risk note.
- For each pick, write one short plain-English sentence on why it's a good clue, and one short note on its main risk (or "no meaningful risk" if none).

Return your picks ranked best first.`;
}

function buildResponseSchema(ownWords) {
  return {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        clue: { type: 'STRING' },
        targets: { type: 'ARRAY', items: { type: 'STRING', enum: ownWords } },
        reasoning: { type: 'STRING' },
        risk: { type: 'STRING' },
      },
      required: ['clue', 'targets', 'reasoning', 'risk'],
    },
  };
}

async function callGemini({ apiKey, model, prompt, schema, timeoutMs, fetchImpl }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0.2,
    },
  };

  // The free-tier "-latest" alias routes to whatever model is current, which in practice
  // means occasional real 503 "high demand" spikes — two retries (3 attempts total)
  // absorbs back-to-back transient failures that one retry alone didn't survive.
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // network error / timeout — worth retrying
      clearTimeout(timer);
      lastErr = err;
      if (attempt === maxAttempts - 1) throw lastErr;
      continue;
    }
    clearTimeout(timer);
    if (res.ok) return await res.json();

    // Retry once on transient server errors; a bad key or quota (4xx) won't fix itself.
    lastErr = new Error(`Gemini request failed: ${res.status}`);
    if (res.status >= 500 && attempt < maxAttempts - 1) continue;
    throw lastErr;
  }
  throw lastErr;
}

/**
 * @param {object} params
 * @param {{word:string, color:string, revealed?:boolean}[]} params.board
 * @param {string} params.yourTeam
 * @param {string|undefined} params.apiKey
 * @param {string} [params.model]
 * @param {number} [params.timeoutMs]
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<{ok:true, refined: object[]} | {ok:false, reason:string, detail?:string}>}
 */
export async function refineClues({
  board,
  yourTeam,
  apiKey,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  if (!apiKey) return { ok: false, reason: 'not_configured' };
  if (!Array.isArray(board) || board.length === 0 || typeof yourTeam !== 'string') {
    return { ok: false, reason: 'invalid_board' };
  }

  const ownWords = board.filter((c) => c && c.color === yourTeam && !c.revealed).map((c) => c.word);
  if (ownWords.length < MIN_TARGETS) return { ok: false, reason: 'not_enough_words' };

  const boardNorms = board.map((c) => normalizeWord(c.word));
  const ownWordSet = new Set(ownWords);

  const prompt = buildPrompt({ board, yourTeam });
  const schema = buildResponseSchema(ownWords);

  let data;
  try {
    data = await callGemini({ apiKey, model, prompt, schema, timeoutMs, fetchImpl });
  } catch (err) {
    return { ok: false, reason: 'request_failed', detail: err.message };
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty_response' };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'invalid_shape' };

  const seen = new Set();
  const refined = [];
  for (const item of parsed) {
    if (!item || typeof item.clue !== 'string' || !Array.isArray(item.targets)) continue;

    const clue = item.clue.trim();
    if (!clue || /\s/.test(clue)) continue; // Codenames clues are a single word, never a phrase

    const clueNorm = normalizeWord(clue);
    if (!clueNorm || seen.has(clueNorm)) continue;

    // Never trust the model's word choice on faith, even with enum-constrained targets:
    // re-run the exact same deterministic legality check Stage 1 uses rather than relying
    // on the model's own judgment (it has no built-in notion of Codenames' rules).
    if (!isLegal(clueNorm, boardNorms)) continue;

    const targets = [...new Set(item.targets.filter((t) => ownWordSet.has(t)))].slice(0, MAX_TARGETS);
    if (targets.length < MIN_TARGETS) continue;

    seen.add(clueNorm);
    refined.push({
      clue,
      count: targets.length,
      targetWords: targets,
      reasoning: typeof item.reasoning === 'string' ? item.reasoning.slice(0, 400) : '',
      risk: typeof item.risk === 'string' ? item.risk.slice(0, 200) : '',
    });
    if (refined.length >= MAX_PICKS) break;
  }

  if (refined.length === 0) return { ok: false, reason: 'no_valid_picks' };
  return { ok: true, refined };
}
