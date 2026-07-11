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
function isLegal(candidateNorm, boardNorms) {
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

/**
 * @param {{board: {word:string, color:'blue'|'red'|'neutral'|'assassin'}[], yourTeam: 'blue'|'red'}} game
 * @param {{word:string, norm:string, vector:number[]}[]} wordVectors  candidate clue vocabulary (wordbank)
 * @param {{word:string, norm:string, vector:number[]}[]} boardEmbeddings  live embeddings, same order as game.board
 * @param {{maxCount?: number, topN?: number}} opts
 */
export function rankClues(game, wordVectors, boardEmbeddings, opts = {}) {
  const { board, yourTeam } = game;
  const opponentTeam = yourTeam === 'blue' ? 'red' : 'blue';

  const boardNorms = board.map((c) => normalizeWord(c.word));

  const rows = board.map((card, i) => ({
    word: card.word,
    color: card.color,
    vector: boardEmbeddings[i].vector,
  }));

  const ownRows = rows.filter((r) => r.color === yourTeam);
  const dangerRows = rows.filter((r) => r.color !== yourTeam);

  const maxCount = Math.max(1, Math.min(opts.maxCount ?? 4, ownRows.length || 1));
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
    for (let count = 1; count <= maxCount; count++) {
      const topOwn = ownSims.slice(0, count);
      const coverage = topOwn.reduce((sum, r) => sum + r.sim, 0) / topOwn.length;
      const score = coverage - Math.max(worstDanger.weighted, 0);
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
