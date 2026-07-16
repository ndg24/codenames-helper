import { rankClues, rankGuesses, normalizeWord } from './src/scoring.mjs';

const COLORS = ['blue', 'red', 'neutral', 'assassin'];
const N_CELLS = 25;
const STORAGE_KEY = 'codenames-helper:board-state:v1';

const state = {
  cells: Array.from({ length: N_CELLS }, () => ({ word: '', color: null, revealed: false })),
  yourTeam: 'blue',
  mode: 'spymaster', // 'spymaster' | 'guesser' — guesser mode never reads .color, mirroring what a real guesser knows
};

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cells: state.cells, yourTeam: state.yourTeam, mode: state.mode }));
  } catch {
    // localStorage unavailable (private browsing, quota) — persistence is best-effort
  }
}

function clearPersistedState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.cells) || parsed.cells.length !== N_CELLS) return false;
    const validColors = new Set([...COLORS, null]);
    for (const c of parsed.cells) {
      if (typeof c.word !== 'string' || !validColors.has(c.color) || typeof c.revealed !== 'boolean') return false;
    }
    if (parsed.yourTeam !== 'blue' && parsed.yourTeam !== 'red') return false;
    state.cells = parsed.cells;
    state.yourTeam = parsed.yourTeam;
    state.mode = parsed.mode === 'guesser' ? 'guesser' : 'spymaster';
    return true;
  } catch {
    return false;
  }
}

function hasAnyBoardData() {
  return state.cells.some((c) => c.word.trim() !== '' || c.color !== null);
}

function resetBoard(opts = {}) {
  if (!opts.skipConfirm && hasAnyBoardData()) {
    const ok = window.confirm('Reset the board? This clears all words, colors, and turn progress.');
    if (!ok) return;
  }
  state.cells = Array.from({ length: N_CELLS }, () => ({ word: '', color: null, revealed: false }));
  clearPersistedState();
  buildAllGrids();
  updateGetCluesState();
  updateRankGuessesState();
  endgameBanner.style.display = 'none';
  clueList.innerHTML = '';
  lastRawResults = [];
  lastGuessContext = null;
  guessList.innerHTML = '';
  guessStatus.textContent = '';
  showScreen(state.mode === 'guesser' ? 'guess' : 'board');
}

let wordVectorsPromise = null;
let extractorPromise = null;

const boardGrid = document.getElementById('boardGrid');
const boardStatus = document.getElementById('boardStatus');
const getCluesBtn = document.getElementById('getCluesBtn');
const clearBoardBtn = document.getElementById('clearBoardBtn');
const resetGameBtn = document.getElementById('resetGameBtn');
const backToBoardBtn = document.getElementById('backToBoardBtn');
const regenerateBtn = document.getElementById('regenerateBtn');
const refineBtn = document.getElementById('refineBtn');
const refineStatus = document.getElementById('refineStatus');
const clueList = document.getElementById('clueList');
const clueHeading = document.getElementById('clueHeading');
const clueCountBadge = document.getElementById('clueCountBadge');
const boardStatusList = document.getElementById('boardStatusList');
const remainingTally = document.getElementById('remainingTally');
const endgameBanner = document.getElementById('endgameBanner');

// All screens toggle .active the same way regardless of mode; the breadcrumb (stepEls)
// uses a mode-specific subset/order, since Guesser mode replaces board+clues with one step.
const ALL_SCREENS = ['capture', 'confirm', 'board', 'clues', 'guess'];
const screenEls = {
  capture: document.getElementById('screen-capture'),
  confirm: document.getElementById('screen-confirm'),
  board: document.getElementById('screen-board'),
  clues: document.getElementById('screen-clues'),
  guess: document.getElementById('screen-guess'),
};
const stepEls = {
  capture: document.getElementById('step-capture'),
  confirm: document.getElementById('step-confirm'),
  board: document.getElementById('step-board'),
  clues: document.getElementById('step-clues'),
  guess: document.getElementById('step-guess'),
};
function stepOrderForMode() {
  return state.mode === 'guesser' ? ['capture', 'confirm', 'guess'] : ['capture', 'confirm', 'board', 'clues'];
}

const photoInput = document.getElementById('photoInput');
const dropzone = document.getElementById('dropzone');
const capturePreview = document.getElementById('capturePreview');
const dropzoneHint = document.getElementById('dropzoneHint');
const captureStatus = document.getElementById('captureStatus');
const manualEntryBtn = document.getElementById('manualEntryBtn');
const readBoardBtn = document.getElementById('readBoardBtn');
const confirmGrid = document.getElementById('confirmGrid');
const confirmWarning = document.getElementById('confirmWarning');
const retakePhotoBtn = document.getElementById('retakePhotoBtn');
const confirmWordsBtn = document.getElementById('confirmWordsBtn');
const guessGrid = document.getElementById('guessGrid');
const clueWordInput = document.getElementById('clueWordInput');
const clueCountInput = document.getElementById('clueCountInput');
const rankGuessesBtn = document.getElementById('rankGuessesBtn');
const guessStatus = document.getElementById('guessStatus');
const guessList = document.getElementById('guessList');
const clearGuessBoardBtn = document.getElementById('clearGuessBoardBtn');

let lastRawResults = [];
let lastGuessContext = null; // { clueVector, boardEmbeddings } — cached so a reveal-toggle can re-filter without re-embedding

const REFINE_ERROR_MESSAGES = {
  not_configured: 'AI clue generation isn’t set up (no GEMINI_API_KEY on the server) — showing offline candidates.',
  not_enough_words: 'Your team needs at least 2 words left for Gemini to build a clue — showing offline candidates.',
  invalid_board: 'Board data was invalid — showing offline candidates.',
  request_failed: 'Gemini request failed — showing offline candidates.',
  empty_response: 'Gemini returned an empty response — showing offline candidates.',
  invalid_json: 'Gemini returned an unreadable response — showing offline candidates.',
  invalid_shape: 'Gemini returned an unexpected response — showing offline candidates.',
  no_valid_picks: 'None of Gemini’s picks passed the legality check — showing offline candidates.',
  payload_too_large: 'Request was too large — showing offline candidates.',
};

const PARSE_ERROR_MESSAGES = {
  not_configured: 'Photo capture isn’t set up (no ANTHROPIC_API_KEY on the server).',
  invalid_image: 'That file couldn’t be read as an image.',
  request_failed: 'The board-reading request failed.',
  empty_response: 'Got an empty response while reading the board.',
  invalid_shape: 'Got an unexpected response while reading the board.',
  invalid_json: 'Got an unreadable response while reading the board.',
  payload_too_large: 'That image was too large.',
};

function buildWordGrid(container, { includeColors }) {
  container.innerHTML = '';
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
      updateRankGuessesState();
      persistState();
    });
    cellEl.appendChild(input);

    if (includeColors) {
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
          persistState();
        });
        swatches.appendChild(btn);
      });
      cellEl.appendChild(swatches);
    }

    const revealBtn = document.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = 'reveal-toggle';
    revealBtn.addEventListener('click', () => {
      state.cells[i].revealed = !state.cells[i].revealed;
      renderCellRevealed(cellEl, state.cells[i].revealed);
      persistState();
      if (!includeColors) refreshGuessListFromCache();
    });
    cellEl.appendChild(revealBtn);

    container.appendChild(cellEl);
    if (includeColors) renderCellColor(cellEl, cell.color);
    renderCellRevealed(cellEl, cell.revealed);
  });
}

function buildBoardGrid() {
  buildWordGrid(boardGrid, { includeColors: true });
}

function buildGuesserGrid() {
  buildWordGrid(guessGrid, { includeColors: false });
}

function buildAllGrids() {
  buildBoardGrid();
  buildGuesserGrid();
}

function renderCellColor(cellEl, color) {
  COLORS.forEach((c) => cellEl.classList.remove(`color-${c}`));
  if (color) cellEl.classList.add(`color-${color}`);
  cellEl.querySelectorAll('.swatch').forEach((btn) => {
    btn.classList.toggle('active', btn.classList.contains(color));
  });
}

function renderCellRevealed(cellEl, revealed) {
  cellEl.classList.toggle('revealed', revealed);
  const revealBtn = cellEl.querySelector('.reveal-toggle');
  revealBtn.textContent = revealed ? 'Guessed ✕ undo' : 'Mark guessed';
}

function updateGetCluesState() {
  const complete = state.cells.every((c) => c.word.trim() !== '' && c.color !== null);
  getCluesBtn.disabled = !complete;
  if (!complete) {
    boardStatus.textContent = '';
    boardStatus.classList.remove('error');
  }
}

function updateRankGuessesState() {
  const complete = state.cells.every((c) => c.word.trim() !== '');
  rankGuessesBtn.disabled = !complete;
}

document.querySelectorAll('.team-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.yourTeam = btn.dataset.team;
    document.querySelectorAll('.team-pill').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    persistState();
  });
});

function updateModeUI() {
  document.querySelector('.steps').classList.toggle('mode-guesser', state.mode === 'guesser');
  document.querySelectorAll('.mode-pill').forEach((b) => b.classList.toggle('selected', b.dataset.mode === state.mode));
}

document.querySelectorAll('.mode-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    persistState();
    updateModeUI();
  });
});

clearBoardBtn.addEventListener('click', () => resetBoard());
resetGameBtn.addEventListener('click', () => resetBoard());
clearGuessBoardBtn.addEventListener('click', () => resetBoard());

function showScreen(name) {
  ALL_SCREENS.forEach((s) => screenEls[s].classList.toggle('active', s === name));
  const order = stepOrderForMode();
  const idx = order.indexOf(name);
  order.forEach((s, i) => {
    stepEls[s].classList.toggle('active', s === name);
    stepEls[s].classList.toggle('done', i < idx);
  });
}

backToBoardBtn.addEventListener('click', () => showScreen('board'));

// --- Photo capture -----------------------------------------------------

const MAX_IMAGE_DIMENSION = 1568; // Anthropic's documented vision sweet spot; also bounds request size/cost.

let capturedImage = null; // { base64, mimeType } — transient, not persisted across reloads
let pendingWords = [];
let originalPendingWords = [];
let autoCorrectedWords = []; // per-cell: snapped to a wordbank match by server-side OCR correction

function resetCaptureUI() {
  capturedImage = null;
  capturePreview.hidden = true;
  capturePreview.src = '';
  dropzoneHint.hidden = false;
  readBoardBtn.disabled = true;
  captureStatus.textContent = '';
  captureStatus.classList.remove('error');
  photoInput.value = '';
}

function loadImageFromFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      capturedImage = { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' };
      capturePreview.src = dataUrl;
      capturePreview.hidden = false;
      dropzoneHint.hidden = true;
      readBoardBtn.disabled = false;
      captureStatus.textContent = '';
      captureStatus.classList.remove('error');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

photoInput.addEventListener('change', () => {
  if (photoInput.files[0]) loadImageFromFile(photoInput.files[0]);
});

dropzone.addEventListener('click', () => photoInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    photoInput.click();
  }
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) loadImageFromFile(e.dataTransfer.files[0]);
});
document.addEventListener('paste', (e) => {
  if (!screenEls.capture.classList.contains('active')) return;
  const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'));
  if (item) loadImageFromFile(item.getAsFile());
});

async function parseBoardPhoto() {
  if (!capturedImage) return;
  readBoardBtn.disabled = true;
  manualEntryBtn.disabled = true;
  captureStatus.classList.remove('error');
  captureStatus.textContent = 'Reading board…';
  try {
    const res = await fetch('/api/parse-board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: capturedImage.base64, mimeType: capturedImage.mimeType }),
    });
    const data = await res.json();
    if (data.ok) {
      pendingWords = data.words.slice();
      originalPendingWords = data.words.slice();
      autoCorrectedWords = Array.isArray(data.corrected) ? data.corrected.slice() : pendingWords.map(() => false);
      captureStatus.textContent = '';
      buildConfirmGrid();
      showScreen('confirm');
    } else {
      const reason = PARSE_ERROR_MESSAGES[data.reason] || 'Could not read the board from that photo.';
      captureStatus.textContent = `${reason} You can retry or enter words manually.`;
      captureStatus.classList.add('error');
    }
  } catch (err) {
    console.error(err);
    captureStatus.textContent = 'Could not reach the server. You can retry or enter words manually.';
    captureStatus.classList.add('error');
  } finally {
    readBoardBtn.disabled = !capturedImage;
    manualEntryBtn.disabled = false;
  }
}

readBoardBtn.addEventListener('click', parseBoardPhoto);
manualEntryBtn.addEventListener('click', () => showScreen(state.mode === 'guesser' ? 'guess' : 'board'));

// --- Confirm words -------------------------------------------------------

function startEditConfirmCell(row, i) {
  if (row.querySelector('input')) return;
  row.classList.add('editing');
  row.textContent = '';
  const input = document.createElement('input');
  input.value = pendingWords[i];
  row.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const newVal = input.value.trim().toUpperCase();
    pendingWords[i] = newVal;
    autoCorrectedWords[i] = false;
    row.classList.remove('editing', 'corrected');
    row.classList.toggle('blank', !newVal);
    row.classList.toggle('edited', newVal !== originalPendingWords[i]);
    row.textContent = newVal || '—';
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
}

function buildConfirmGrid() {
  confirmGrid.innerHTML = '';
  confirmWarning.textContent = '';
  pendingWords.forEach((word, i) => {
    const row = document.createElement('div');
    row.className = 'word-row';
    row.tabIndex = 0;
    if (!word) row.classList.add('blank');
    if (autoCorrectedWords[i]) row.classList.add('corrected');
    row.textContent = word || '—';
    row.addEventListener('click', () => startEditConfirmCell(row, i));
    confirmGrid.appendChild(row);
  });
}

retakePhotoBtn.addEventListener('click', () => {
  resetCaptureUI();
  showScreen('capture');
});

confirmWordsBtn.addEventListener('click', () => {
  const missing = pendingWords.filter((w) => !w.trim()).length;
  if (missing > 0) {
    confirmWarning.textContent = `Fill in ${missing} missing word${missing === 1 ? '' : 's'} before continuing.`;
    return;
  }
  confirmWarning.textContent = '';
  state.cells = pendingWords.map((word) => ({ word, color: null, revealed: false }));
  persistState();
  buildAllGrids();
  updateGetCluesState();
  updateRankGuessesState();
  showScreen(state.mode === 'guesser' ? 'guess' : 'board');
});

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

async function embedText(extractor, text) {
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

async function embedBoardWords(extractor) {
  const embeddings = [];
  for (const cell of state.cells) {
    const vector = await embedText(extractor, cell.word);
    embeddings.push({ word: cell.word, norm: normalizeWord(cell.word), vector });
  }
  return embeddings;
}

function riskColorDot(color) {
  return color || 'neutral';
}

function tally() {
  const counts = { blue: 0, red: 0, neutral: 0, assassin: 0 };
  for (const c of state.cells) {
    if (!c.revealed && c.color) counts[c.color]++;
  }
  return counts;
}

function renderRemainingTally() {
  const counts = tally();
  remainingTally.innerHTML = ['blue', 'red', 'neutral', 'assassin']
    .map((c) => `<span class="tally-item"><span class="dot ${c}"></span>${counts[c]} ${c}</span>`)
    .join('');
}

let statusUpdatePending = false;

function renderBoardStatus() {
  boardStatusList.innerHTML = '';
  state.cells.forEach((cell, i) => {
    if (!cell.word.trim() || !cell.color) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `board-chip ${cell.color}${cell.revealed ? ' revealed' : ''}`;
    chip.innerHTML = `<span class="dot"></span><span class="word">${cell.word}</span>`;
    chip.addEventListener('click', async () => {
      if (statusUpdatePending) return;
      statusUpdatePending = true;
      state.cells[i].revealed = !state.cells[i].revealed;
      const boardCellEl = boardGrid.querySelector(`.board-cell[data-index="${i}"]`);
      if (boardCellEl) renderCellRevealed(boardCellEl, state.cells[i].revealed);
      persistState();
      await getClues();
      statusUpdatePending = false;
    });
    boardStatusList.appendChild(chip);
  });
}

function renderClues(results, opts = {}) {
  const source = opts.source || 'stage1';
  clueHeading.textContent = `Ranked clues for ${state.yourTeam.toUpperCase()}`;
  clueCountBadge.innerHTML = source === 'gemini'
    ? `<span>●</span> ${results.length} AI-generated picks`
    : `<span>●</span> ${results.length} candidates`;
  clueList.innerHTML = '';
  if (results.length === 0) {
    clueList.innerHTML = '<p class="subtext">No legal candidates found in the word bank for this board.</p>';
    return;
  }
  for (const r of results) {
    const row = document.createElement('div');
    row.className = source === 'gemini' ? 'clue-row refined' : 'clue-row';

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

    row.appendChild(head);
    row.appendChild(targets);

    // Stage 1 candidates carry an embedding-based risk readout; Gemini's own picks
    // have no such vector to compare, so they only show its plain-English risk note below.
    if (source !== 'gemini') {
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
      row.appendChild(risk);
    }

    if (r.reasoning) {
      const reasoning = document.createElement('div');
      reasoning.className = 'ai-reasoning';
      reasoning.textContent = r.reasoning;
      row.appendChild(reasoning);
    }
    if (r.risk) {
      const aiRisk = document.createElement('div');
      aiRisk.className = 'ai-risk';
      aiRisk.textContent = `Gemini: ${r.risk}`;
      row.appendChild(aiRisk);
    }

    clueList.appendChild(row);
  }
}

function renderEndgame(message, danger) {
  endgameBanner.textContent = message;
  endgameBanner.classList.toggle('danger', !!danger);
  endgameBanner.style.display = 'block';
}

async function getClues() {
  getCluesBtn.disabled = true;
  boardStatus.classList.remove('error');
  refineStatus.textContent = '';
  refineStatus.classList.remove('error');
  refineBtn.disabled = true;
  lastRawResults = [];
  try {
    renderBoardStatus();
    renderRemainingTally();

    const counts = tally();
    endgameBanner.style.display = 'none';
    clueCountBadge.style.display = '';
    if (counts.assassin === 0 && state.cells.some((c) => c.color === 'assassin')) {
      renderEndgame('Assassin revealed — game over.', true);
      clueCountBadge.style.display = 'none';
      clueList.innerHTML = '';
      showScreen('clues');
      return;
    }
    if (counts[state.yourTeam] === 0) {
      renderEndgame(`All of ${state.yourTeam.toUpperCase()}'s words found — your team wins!`);
      clueCountBadge.style.display = 'none';
      clueList.innerHTML = '';
      showScreen('clues');
      return;
    }

    boardStatus.textContent = 'Loading model (first run only)…';
    const extractor = await loadExtractor();
    boardStatus.textContent = 'Embedding board words…';
    const [wordVectors, boardEmbeddings] = await Promise.all([loadWordVectors(), embedBoardWords(extractor)]);
    boardStatus.textContent = 'Ranking candidates…';
    const results = rankClues(
      { board: state.cells.map((c) => ({ word: c.word, color: c.color, revealed: c.revealed })), yourTeam: state.yourTeam },
      wordVectors,
      boardEmbeddings,
      { minCount: 2, maxCount: 4, topN: 15 }
    );
    boardStatus.textContent = '';
    lastRawResults = results;
    refineBtn.disabled = counts[state.yourTeam] < 2;
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

async function refineWithGemini() {
  if (tally()[state.yourTeam] < 2) return;
  refineBtn.disabled = true;
  refineStatus.classList.remove('error');
  refineStatus.textContent = 'Asking Gemini for clue ideas…';
  try {
    const res = await fetch('/api/refine-clues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        board: state.cells.map((c) => ({ word: c.word, color: c.color, revealed: c.revealed })),
        yourTeam: state.yourTeam,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      renderClues(data.refined, { source: 'gemini' });
      refineStatus.textContent = `Gemini's own picks — ${data.refined.length} idea${data.refined.length === 1 ? '' : 's'}. Regenerate to return to the full offline list.`;
    } else {
      renderClues(lastRawResults);
      refineStatus.textContent = REFINE_ERROR_MESSAGES[data.reason] || 'AI clue generation unavailable — showing offline candidates.';
      refineStatus.classList.add('error');
    }
  } catch (err) {
    console.error(err);
    renderClues(lastRawResults);
    refineStatus.textContent = 'AI clue generation unavailable — showing offline candidates.';
    refineStatus.classList.add('error');
  } finally {
    refineBtn.disabled = false;
  }
}

getCluesBtn.addEventListener('click', getClues);
regenerateBtn.addEventListener('click', getClues);
refineBtn.addEventListener('click', refineWithGemini);

// --- Guesser mode --------------------------------------------------------

function renderGuesses(results, count) {
  guessList.innerHTML = '';
  if (results.length === 0) {
    guessList.innerHTML = '<p class="subtext">No unrevealed words left to guess.</p>';
    return;
  }
  results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = i < count ? 'guess-row top-pick' : 'guess-row';
    const word = document.createElement('span');
    word.className = 'guess-word';
    word.textContent = r.word.toUpperCase();
    const sim = document.createElement('span');
    sim.className = 'guess-sim';
    sim.textContent = r.sim.toFixed(2);
    row.appendChild(word);
    row.appendChild(sim);
    guessList.appendChild(row);
  });
}

function refreshGuessListFromCache() {
  if (!lastGuessContext) return;
  const results = rankGuesses(lastGuessContext.clueVector, state.cells, lastGuessContext.boardEmbeddings, { topN: 25 });
  renderGuesses(results, Number(clueCountInput.value) || 2);
}

async function rankGuessesForClue() {
  const clueWord = clueWordInput.value.trim();
  guessStatus.classList.remove('error');
  if (!clueWord) {
    guessStatus.textContent = 'Type the clue word you were given first.';
    guessStatus.classList.add('error');
    return;
  }
  rankGuessesBtn.disabled = true;
  guessStatus.textContent = 'Loading model (first run only)…';
  try {
    const extractor = await loadExtractor();
    guessStatus.textContent = 'Embedding…';
    const [clueVector, boardEmbeddings] = await Promise.all([
      embedText(extractor, clueWord),
      embedBoardWords(extractor),
    ]);
    lastGuessContext = { clueVector, boardEmbeddings };
    guessStatus.textContent = '';
    const results = rankGuesses(clueVector, state.cells, boardEmbeddings, { topN: 25 });
    renderGuesses(results, Number(clueCountInput.value) || 2);
  } catch (err) {
    console.error(err);
    guessStatus.textContent = `Error: ${err.message}`;
    guessStatus.classList.add('error');
  } finally {
    updateRankGuessesState();
  }
}

rankGuessesBtn.addEventListener('click', rankGuessesForClue);

const restored = loadPersistedState();
buildAllGrids();
updateGetCluesState();
updateRankGuessesState();
updateModeUI();
if (restored) {
  document.querySelectorAll('.team-pill').forEach((b) => b.classList.toggle('selected', b.dataset.team === state.yourTeam));
  showScreen(state.mode === 'guesser' ? 'guess' : 'board');
} else {
  showScreen('capture');
}
