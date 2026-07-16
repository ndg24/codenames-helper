// Pure JS — no Node- or browser-only APIs. Imported unchanged by scripts/test-scoring.mjs (Node)
// and app.js (browser).

export function normalizeWord(word) {
  return word.trim().toLowerCase().replace(/[^a-z]/g, '');
}

export function cosineSim(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// A candidate clue can't be a board word, or share a substring root with one
// (e.g. "SNOWMAN" can't clue "SNOW"). Hard filter, not left to model judgment.
// Exported so the Gemini refinement pass (server/refineClues.mjs) can re-apply
// the same deterministic check on model output rather than trusting it.
export function isLegal(candidateNorm, boardNorms) {
  if (!candidateNorm) return false;
  for (const boardNorm of boardNorms) {
    if (!boardNorm) continue;
    if (candidateNorm === boardNorm) return false;
    if (candidateNorm.includes(boardNorm) || boardNorm.includes(candidateNorm)) return false;
  }
  return true;
}

const DANGER_WEIGHTS = {
  assassin: 2,
  opponent: 1,
  neutral: 0.5,
};

// Coverage is an average of sorted-descending similarities, so it is mathematically
// non-increasing as count grows — without a counterweight, count=1 always wins since
// the danger penalty doesn't change with count either. MULTI_WORD_BONUS rewards the
// compression a multi-word clue gives (fewer turns to clear the board), while
// MIN_TARGET_SIM stops a barely-related word from being dragged in just to rack up count.
const MULTI_WORD_BONUS = 0.05;
const MIN_TARGET_SIM = 0.2;
const DEFAULT_MIN_COUNT = 2;

/**
 * @param {{board: {word:string, color:'blue'|'red'|'neutral'|'assassin', revealed?: boolean}[], yourTeam: 'blue'|'red'}} game
 * @param {{word:string, norm:string, vector:number[]}[]} wordVectors  candidate clue vocabulary (wordbank)
 * @param {{word:string, norm:string, vector:number[]}[]} boardEmbeddings  live embeddings, same order as game.board
 * @param {{minCount?: number, maxCount?: number, topN?: number}} opts  minCount defaults to 2 — no single-word clues.
 *   If fewer than minCount own-team words remain, no candidate can qualify and results will be empty.
 */
export function rankClues(game, wordVectors, boardEmbeddings, opts = {}) {
  const { board, yourTeam } = game;
  const opponentTeam = yourTeam === 'blue' ? 'red' : 'blue';

  // Legality is checked against every word still on the table, revealed or not —
  // the physical card doesn't disappear, so the clue-can't-match-a-board-word rule still applies to it.
  const boardNorms = board.map((c) => normalizeWord(c.word));

  const rows = board.map((card, i) => ({
    word: card.word,
    color: card.color,
    revealed: !!card.revealed,
    vector: boardEmbeddings[i].vector,
  }));

  // Coverage/risk scoring only cares about words still in play — a revealed card is
  // already known to both teams and no longer needs (or poses) any clue risk.
  const ownRows = rows.filter((r) => r.color === yourTeam && !r.revealed);
  const dangerRows = rows.filter((r) => r.color !== yourTeam && !r.revealed);

  if (ownRows.length === 0) return [];

  const maxCount = Math.max(1, Math.min(opts.maxCount ?? 4, ownRows.length || 1));
  const minCount = Math.max(1, opts.minCount ?? DEFAULT_MIN_COUNT);
  const topN = opts.topN ?? 15;

  const results = [];

  for (const candidate of wordVectors) {
    if (!isLegal(candidate.norm, boardNorms)) continue;

    const ownSims = ownRows
      .map((r) => ({ word: r.word, sim: cosineSim(candidate.vector, r.vector) }))
      .sort((a, b) => b.sim - a.sim);

    const dangerSims = dangerRows.map((r) => {
      const sim = cosineSim(candidate.vector, r.vector);
      const weight = DANGER_WEIGHTS[r.color === opponentTeam ? 'opponent' : r.color] ?? 1;
      return { word: r.word, color: r.color, sim, weighted: sim * weight };
    });

    const worstDanger = dangerSims.reduce(
      (worst, d) => (d.weighted > worst.weighted ? d : worst),
      { word: null, color: null, sim: 0, weighted: -Infinity }
    );

    let best = null;
    for (let count = minCount; count <= maxCount; count++) {
      const topOwn = ownSims.slice(0, count);
      // The floor only gates words #2+: the single strongest own word is always a legal
      // target, but padding on a 2nd/3rd/4th word that's too weak drops the candidate
      // outright (never falls back to a smaller count below minCount).
      if (count > 1 && topOwn[topOwn.length - 1].sim < MIN_TARGET_SIM) break;
      const coverage = topOwn.reduce((sum, r) => sum + r.sim, 0) / topOwn.length;
      const score = coverage - Math.max(worstDanger.weighted, 0) + (count - 1) * MULTI_WORD_BONUS;
      const entry = {
        clue: candidate.word,
        count,
        targetWords: topOwn.map((r) => r.word),
        score,
        riskWord: worstDanger.word,
        riskColor: worstDanger.color,
        riskSim: worstDanger.sim,
      };
      if (!best || entry.score > best.score) best = entry;
    }
    if (best) results.push(best);
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topN);
}

/**
 * Reverse of rankClues: given the clue a guesser was told, rank the board's own words
 * by similarity to it. No color/danger weighting and no legality filter — a real guesser
 * doesn't know colors, and the candidates here are the board words themselves, not a
 * separate clue vocabulary.
 * @param {number[]} clueVector  embedding of the clue word the guesser was given
 * @param {{word:string, revealed?: boolean}[]} board
 * @param {{vector:number[]}[]} boardEmbeddings  same order/length as board
 * @param {{topN?: number}} opts
 */
export function rankGuesses(clueVector, board, boardEmbeddings, opts = {}) {
  const topN = opts.topN ?? 25;
  return board
    .map((cell, i) => ({ word: cell.word, sim: cosineSim(clueVector, boardEmbeddings[i].vector) }))
    .filter((r, i) => !board[i].revealed && r.word.trim() !== '')
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topN);
}
