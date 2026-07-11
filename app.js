import { rankClues, normalizeWord } from './src/scoring.mjs';

const COLORS = ['blue', 'red', 'neutral', 'assassin'];
const N_CELLS = 25;

const state = {
  cells: Array.from({ length: N_CELLS }, () => ({ word: '', color: null })),
  yourTeam: 'blue',
};

let wordVectorsPromise = null;
let extractorPromise = null;

const boardGrid = document.getElementById('boardGrid');
const boardStatus = document.getElementById('boardStatus');
const getCluesBtn = document.getElementById('getCluesBtn');
const clearBoardBtn = document.getElementById('clearBoardBtn');
const backToBoardBtn = document.getElementById('backToBoardBtn');
const regenerateBtn = document.getElementById('regenerateBtn');
const clueList = document.getElementById('clueList');
const clueHeading = document.getElementById('clueHeading');
const clueCountBadge = document.getElementById('clueCountBadge');
const stepBoard = document.getElementById('step-board');
const stepClues = document.getElementById('step-clues');
const screenBoard = document.getElementById('screen-board');
const screenClues = document.getElementById('screen-clues');

function buildBoardGrid() {
  boardGrid.innerHTML = '';
  state.cells.forEach((cell, i) => {
    const cellEl = document.createElement('div');
    cellEl.className = 'board-cell';
    cellEl.dataset.index = String(i);

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Word';
    input.value = cell.word;
    input.addEventListener('input', () => {
      state.cells[i].word = input.value;
      updateGetCluesState();
    });

    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    COLORS.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `swatch ${color}`;
      btn.title = color;
      btn.addEventListener('click', () => {
        state.cells[i].color = state.cells[i].color === color ? null : color;
        renderCellColor(cellEl, state.cells[i].color);
        updateGetCluesState();
      });
      swatches.appendChild(btn);
    });

    cellEl.appendChild(input);
    cellEl.appendChild(swatches);
    boardGrid.appendChild(cellEl);
    renderCellColor(cellEl, cell.color);
  });
}

function renderCellColor(cellEl, color) {
  COLORS.forEach((c) => cellEl.classList.remove(`color-${c}`));
  if (color) cellEl.classList.add(`color-${color}`);
  cellEl.querySelectorAll('.swatch').forEach((btn) => {
    btn.classList.toggle('active', btn.classList.contains(color));
  });
}

function updateGetCluesState() {
  const complete = state.cells.every((c) => c.word.trim() !== '' && c.color !== null);
  getCluesBtn.disabled = !complete;
  if (!complete) {
    boardStatus.textContent = '';
    boardStatus.classList.remove('error');
  }
}

document.querySelectorAll('.team-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.yourTeam = btn.dataset.team;
    document.querySelectorAll('.team-pill').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
});

clearBoardBtn.addEventListener('click', () => {
  state.cells = Array.from({ length: N_CELLS }, () => ({ word: '', color: null }));
  buildBoardGrid();
  updateGetCluesState();
});

function showScreen(name) {
  screenBoard.classList.toggle('active', name === 'board');
  screenClues.classList.toggle('active', name === 'clues');
  stepBoard.classList.toggle('active', name === 'board');
  stepBoard.classList.toggle('done', name === 'clues');
  stepClues.classList.toggle('active', name === 'clues');
}

backToBoardBtn.addEventListener('click', () => showScreen('board'));

async function loadWordVectors() {
  if (!wordVectorsPromise) {
    wordVectorsPromise = fetch('data/word-vectors.json').then((r) => {
      if (!r.ok) throw new Error(`Failed to load word-vectors.json (${r.status})`);
      return r.json();
    });
  }
  return wordVectorsPromise;
}

async function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
      env.allowLocalModels = false;
      return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    })();
  }
  return extractorPromise;
}

async function embedBoardWords(extractor) {
  const embeddings = [];
  for (const cell of state.cells) {
    const output = await extractor(cell.word, { pooling: 'mean', normalize: true });
    embeddings.push({ word: cell.word, norm: normalizeWord(cell.word), vector: Array.from(output.data) });
  }
  return embeddings;
}

function riskColorDot(color) {
  return color || 'neutral';
}

function renderClues(results) {
  clueHeading.textContent = `Ranked clues for ${state.yourTeam.toUpperCase()}`;
  clueCountBadge.innerHTML = `<span>●</span> ${results.length} candidates`;
  clueList.innerHTML = '';
  if (results.length === 0) {
    clueList.innerHTML = '<p class="subtext">No legal candidates found in the word bank for this board.</p>';
    return;
  }
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'clue-row';

    const head = document.createElement('div');
    head.className = 'clue-head';
    const word = document.createElement('span');
    word.className = 'clue-word';
    word.textContent = r.clue.toUpperCase();
    const count = document.createElement('span');
    count.className = 'clue-count';
    count.textContent = r.count;
    head.appendChild(word);
    head.appendChild(count);

    const targets = document.createElement('div');
    targets.className = 'targets';
    r.targetWords.forEach((w) => {
      const tag = document.createElement('span');
      tag.className = 'target-tag';
      tag.textContent = w;
      targets.appendChild(tag);
    });

    const risk = document.createElement('div');
    risk.className = 'risk-note';
    if (r.riskWord) {
      const dot = document.createElement('span');
      dot.className = `dot ${riskColorDot(r.riskColor)}`;
      risk.appendChild(dot);
      risk.appendChild(document.createTextNode(`closest risk: ${r.riskWord} (${r.riskColor}, sim ${r.riskSim.toFixed(2)})`));
    } else {
      risk.textContent = 'no meaningful risk detected';
    }

    row.appendChild(head);
    row.appendChild(targets);
    row.appendChild(risk);
    clueList.appendChild(row);
  }
}

async function getClues() {
  getCluesBtn.disabled = true;
  boardStatus.classList.remove('error');
  try {
    boardStatus.textContent = 'Loading model (first run only)…';
    const extractor = await loadExtractor();
    boardStatus.textContent = 'Embedding board words…';
    const [wordVectors, boardEmbeddings] = await Promise.all([loadWordVectors(), embedBoardWords(extractor)]);
    boardStatus.textContent = 'Ranking candidates…';
    const results = rankClues(
      { board: state.cells.map((c) => ({ word: c.word, color: c.color })), yourTeam: state.yourTeam },
      wordVectors,
      boardEmbeddings,
      { maxCount: 4, topN: 15 }
    );
    boardStatus.textContent = '';
    renderClues(results);
    showScreen('clues');
  } catch (err) {
    console.error(err);
    boardStatus.textContent = `Error: ${err.message}`;
    boardStatus.classList.add('error');
  } finally {
    updateGetCluesState();
  }
}

getCluesBtn.addEventListener('click', getClues);
regenerateBtn.addEventListener('click', getClues);

buildBoardGrid();
updateGetCluesState();
