// Pure JS — no Node- or browser-only APIs, same portability constraint as scoring.mjs.
// Snaps vision-read words to the nearest wordbank entry when the match is close and
// unambiguous. Per the OCR-correction risk noted in the build plan: a bad silent
// correction (snapping to an unrelated word) is a worse failure than leaving a vision
// misread alone for the user to fix on the confirm screen, so ties or distant matches
// are left untouched rather than guessed at.

import { normalizeWord } from './scoring.mjs';

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

// Threshold scales with word length so a short word doesn't get rewritten by one
// typo's worth of edit distance, while a long word can absorb more OCR noise.
function maxDistanceFor(len) {
  if (len < 3) return 0;
  if (len <= 5) return 1;
  if (len <= 8) return 2;
  return 3;
}

/**
 * @param {string[]} words - vision-read words (any casing; '' for unreadable cells)
 * @param {string[]} bank - raw wordbank entries (any casing)
 * @returns {{ words: string[], corrected: boolean[] }} same length/order as `words`;
 *   `corrected[i]` is true only where `words[i]` was snapped to a bank entry.
 */
export function correctWords(words, bank) {
  const rawByNorm = new Map();
  for (const w of bank || []) {
    const norm = normalizeWord(w);
    if (norm && !rawByNorm.has(norm)) rawByNorm.set(norm, w.trim().toUpperCase());
  }
  const bankNorms = [...rawByNorm.keys()];

  const outWords = [];
  const corrected = [];

  for (const word of words) {
    const norm = normalizeWord(word);
    const maxDist = maxDistanceFor(norm.length);

    if (!norm || maxDist === 0 || rawByNorm.has(norm)) {
      outWords.push(word);
      corrected.push(false);
      continue;
    }

    let bestNorm = null;
    let bestDist = Infinity;
    let tie = false;
    for (const candidateNorm of bankNorms) {
      const dist = levenshtein(norm, candidateNorm);
      if (dist > maxDist) continue;
      if (dist < bestDist) {
        bestDist = dist;
        bestNorm = candidateNorm;
        tie = false;
      } else if (dist === bestDist) {
        tie = true;
      }
    }

    if (bestNorm && !tie) {
      outWords.push(rawByNorm.get(bestNorm));
      corrected.push(true);
    } else {
      outWords.push(word);
      corrected.push(false);
    }
  }

  return { words: outWords, corrected };
}
