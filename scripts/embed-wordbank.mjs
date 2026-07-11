import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@xenova/transformers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function normalize(word) {
  return word.trim().toLowerCase();
}

async function loadWordbank() {
  const raw = await readFile(path.join(root, 'wordbank.txt'), 'utf-8');
  const seen = new Set();
  const words = [];
  for (const line of raw.split('\n')) {
    const word = line.trim();
    if (!word) continue;
    const norm = normalize(word);
    if (seen.has(norm)) continue;
    seen.add(norm);
    words.push(word);
  }
  return words;
}

async function main() {
  const words = await loadWordbank();
  console.log(`Loaded ${words.length} unique words from wordbank.txt`);

  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  const entries = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const output = await extractor(word, { pooling: 'mean', normalize: true });
    entries.push({ word, norm: normalize(word), vector: Array.from(output.data) });
    if ((i + 1) % 100 === 0 || i === words.length - 1) {
      console.log(`Embedded ${i + 1}/${words.length}`);
    }
  }

  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const outPath = path.join(dataDir, 'word-vectors.json');
  await writeFile(outPath, JSON.stringify(entries));
  console.log(`Wrote ${entries.length} vectors to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
