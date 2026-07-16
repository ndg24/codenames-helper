// Vision pass: reads the 25 words off a photographed/screenshotted Codenames board via
// Claude's vision + forced tool-use output, so the client doesn't have to trust free-form
// prose parsing. Colors are intentionally NOT read here — color misreads (glare, lighting,
// edition variance) are a much worse failure mode than a word typo, so color-tagging stays
// on the existing manual dot-tap UI. Server-only module — the API key never reaches the browser.
//
// Each word is then run through correctWords() against the wordbank: an unambiguous close
// match gets silently snapped (and flagged via `corrected` for the confirm-screen UI), while
// an ambiguous or distant one is left as Claude's raw read — see ocrCorrect.mjs.

import { correctWords } from '../src/ocrCorrect.mjs';

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_TIMEOUT_MS = 30000;
const N_CELLS = 25;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const PROMPT = `This photo shows a 5x5 grid of Codenames word cards. Read every card and report the words using the report_words tool.

Rules:
- Report exactly 25 entries, one per cell, in reading order: left-to-right, then top-to-bottom row by row.
- Use the word exactly as printed on the card, in uppercase.
- If a cell is unreadable or obscured, use an empty string "" for that entry rather than guessing.`;

const TOOL = {
  name: 'report_words',
  description: 'Report the 25 words read from the Codenames board photo, in reading order.',
  input_schema: {
    type: 'object',
    properties: {
      words: {
        type: 'array',
        items: { type: 'string' },
        description: 'The 25 board words in reading order (left-to-right, top-to-bottom).',
      },
    },
    required: ['words'],
  },
};

async function callAnthropic({ apiKey, model, imageBase64, mimeType, timeoutMs, fetchImpl }) {
  const url = 'https://api.anthropic.com/v1/messages';
  const body = {
    model,
    max_tokens: 1024,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'report_words' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  };

  // Vision calls cost more per-request than the text-only Gemini refine path, so this caps
  // at one retry (2 attempts total) rather than the two retries used there.
  const maxAttempts = 2;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt === maxAttempts - 1) throw lastErr;
      continue;
    }
    clearTimeout(timer);
    if (res.ok) return await res.json();

    lastErr = new Error(`Anthropic request failed: ${res.status}`);
    if (res.status >= 500 && attempt < maxAttempts - 1) continue;
    throw lastErr;
  }
  throw lastErr;
}

function normalizeWords(rawWords) {
  const words = rawWords.map((w) => (typeof w === 'string' ? w.trim().toUpperCase() : ''));
  const fitted = words.slice(0, N_CELLS);
  while (fitted.length < N_CELLS) fitted.push('');
  return fitted;
}

/**
 * @param {object} params
 * @param {string} params.imageBase64
 * @param {string} params.mimeType
 * @param {string|undefined} params.apiKey
 * @param {string} [params.model]
 * @param {number} [params.timeoutMs]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {string[]} [params.bank] - wordbank entries to snap-correct OCR misreads against
 * @returns {Promise<{ok:true, words: string[], corrected: boolean[]} | {ok:false, reason:string, detail?:string}>}
 */
export async function parseBoard({
  imageBase64,
  mimeType,
  apiKey,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  bank = [],
}) {
  if (!apiKey) return { ok: false, reason: 'not_configured' };
  if (typeof imageBase64 !== 'string' || !imageBase64) return { ok: false, reason: 'invalid_image' };
  if (typeof mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(mimeType)) {
    return { ok: false, reason: 'invalid_image' };
  }

  let data;
  try {
    data = await callAnthropic({ apiKey, model, imageBase64, mimeType, timeoutMs, fetchImpl });
  } catch (err) {
    return { ok: false, reason: 'request_failed', detail: err.message };
  }

  const content = Array.isArray(data?.content) ? data.content : [];
  const toolUse = content.find((block) => block?.type === 'tool_use' && block?.name === 'report_words');
  if (!toolUse) return { ok: false, reason: 'empty_response' };

  const rawWords = toolUse.input?.words;
  if (!Array.isArray(rawWords)) return { ok: false, reason: 'invalid_shape' };

  const { words, corrected } = correctWords(normalizeWords(rawWords), bank);
  return { ok: true, words, corrected };
}
