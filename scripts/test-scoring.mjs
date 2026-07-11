import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@xenova/transformers';
import { rankClues, normalizeWord, cosineSim } from '../src/scoring.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Reuses the 25-word board from confirm-words-mockup.html, with colors assigned
// by hand for this smoke test (standard Codenames counts: 9/8/7/1).
const BOARD = [
  { word: 'FISH', color: 'blue' },
  { word: 'OVEN', color: 'blue' },
  { word: 'BULB', color: 'blue' },
  { word: 'LIGHT', color: 'blue' },
  { word: 'LASER', color: 'blue' },
  { word: 'BOOK', color: 'blue' },
  { word: 'CAMERA', color: 'blue' },
  { word: 'TELESCOPE', color: 'blue' },
  { word: 'POST', color: 'blue' },
  { word: 'GERMANY', color: 'red' },
  { word: 'ENGLAND', color: 'red' },
  { word: 'KING ARTHUR', color: 'red' },
  { word: 'CLASSROOM', color: 'red' },
  { word: 'JUMPER', color: 'red' },
  { word: 'SHORTS', color: 'red' },
  { word: 'SOAP', color: 'red' },
  { word: 'ROPE', color: 'red' },
  { word: 'TIME', color: 'neutral' },
  { word: 'ROSE', color: 'neutral' },
  { word: 'CHIP', color: 'neutral' },
  { word: 'SPRING', color: 'neutral' },
  { word: 'BOX', color: 'neutral' },
  { word: 'PARROT', color: 'neutral' },
  { word: 'STAMP', color: 'neutral' },
  { word: 'LINE', color: 'assassin' },
];

function findVector(vectors, word) {
  const norm = normalizeWord(word);
  const entry = vectors.find((v) => v.norm === norm);
  if (!entry) throw new Error(`"${word}" not found in word-vectors.json`);
  return entry.vector;
}

async function main() {
  const vectorsPath = path.join(root, 'data', 'word-vectors.json');
  const wordVectors = JSON.parse(await readFile(vectorsPath, 'utf-8'));
  console.log(`Loaded ${wordVectors.length} candidate vectors\n`);

  // --- Sanity check embedding quality (per build-plan step 1) ---
  const ocean = findVector(wordVectors, 'ocean');
  const fish = findVector(wordVectors, 'fish');
  const stamp = findVector(wordVectors, 'stamp');
  const oceanFish = cosineSim(ocean, fish);
  const oceanStamp = cosineSim(ocean, stamp);
  console.log('Sanity check: OCEAN vs FISH =', oceanFish.toFixed(3));
  console.log('Sanity check: OCEAN vs STAMP =', oceanStamp.toFixed(3));
  console.log(oceanFish > oceanStamp ? 'PASS (OCEAN closer to FISH than STAMP)\n' : 'FAIL — embeddings look wrong\n');

  // --- Embed the example board live, same as the browser app would ---
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const boardEmbeddings = [];
  for (const card of BOARD) {
    const output = await extractor(card.word, { pooling: 'mean', normalize: true });
    boardEmbeddings.push({ word: card.word, norm: normalizeWord(card.word), vector: Array.from(output.data) });
  }

  const results = rankClues({ board: BOARD, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { maxCount: 4, topN: 10 });

  console.log('Top clue candidates for BLUE:\n');
  for (const r of results) {
    const risk = r.riskWord ? `${r.riskWord} (${r.riskColor}, sim=${r.riskSim.toFixed(2)})` : 'none';
    console.log(
      `${r.clue.toUpperCase()} (${r.count}) -> ${r.targetWords.join(', ')} | score=${r.score.toFixed(3)} | risk: ${risk}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
