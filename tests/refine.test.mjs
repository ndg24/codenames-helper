import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refineClues } from '../server/refineClues.mjs';

const board = [
  { word: 'ocean', color: 'blue', revealed: false },
  { word: 'fish', color: 'blue', revealed: false },
  { word: 'snowman', color: 'red', revealed: false },
  { word: 'stamp', color: 'neutral', revealed: false },
  { word: 'grave', color: 'assassin', revealed: false },
];

function geminiResponse(items) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] } }] }),
  };
}

test('refineClues: not_configured when no API key', async () => {
  const result = await refineClues({ board, yourTeam: 'blue', apiKey: undefined });
  assert.deepEqual(result, { ok: false, reason: 'not_configured' });
});

test('refineClues: not_enough_words when fewer than 2 own words remain', async () => {
  const thinBoard = [
    { word: 'ocean', color: 'blue', revealed: false },
    { word: 'fish', color: 'blue', revealed: true },
    { word: 'grave', color: 'assassin', revealed: false },
  ];
  const result = await refineClues({ board: thinBoard, yourTeam: 'blue', apiKey: 'key' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_enough_words');
});

test('refineClues: accepts a freely-generated clue with valid targets', async () => {
  const fetchImpl = async () =>
    geminiResponse([{ clue: 'water', targets: ['ocean', 'fish'], reasoning: 'covers both', risk: 'no meaningful risk' }]);
  const result = await refineClues({ board, yourTeam: 'blue', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.refined.length, 1);
  assert.equal(result.refined[0].clue, 'water');
  assert.equal(result.refined[0].count, 2);
  assert.deepEqual(result.refined[0].targetWords, ['ocean', 'fish']);
  assert.equal(result.refined[0].reasoning, 'covers both');
});

test('refineClues: drops a pick with fewer than 2 valid targets', async () => {
  const fetchImpl = async () =>
    geminiResponse([{ clue: 'coral', targets: ['ocean'], reasoning: 'x', risk: 'y' }]);
  const result = await refineClues({ board, yourTeam: 'blue', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_valid_picks');
});

test('refineClues: drops targets that are not actually the team\'s remaining words', async () => {
  const fetchImpl = async () =>
    geminiResponse([{ clue: 'water', targets: ['ocean', 'fish', 'hallucinated'], reasoning: 'x', risk: 'y' }]);
  const result = await refineClues({ board, yourTeam: 'blue', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.refined[0].targetWords, ['ocean', 'fish']);
});

test('refineClues: re-applies the legality filter even if the model invents an illegal clue', async () => {
  // "snow" would be illegal against board word "snowman" even though the model invented it freely.
  const fetchImpl = async () =>
    geminiResponse([{ clue: 'snow', targets: ['ocean', 'fish'], reasoning: 'x', risk: 'y' }]);
  const result = await refineClues({ board, yourTeam: 'blue', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_valid_picks');
});

test('refineClues: rejects a multi-word phrase as a clue', async () => {
  const fetchImpl = async () =>
    geminiResponse([{ clue: 'sea creature', targets: ['ocean', 'fish'], reasoning: 'x', risk: 'y' }]);
  const result = await refineClues({ board, yourTeam: 'blue', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_valid_picks');
});

test('refineClues: caps targets at 4 even if the model lists more', async () => {
  const wideBoard = [
    { word: 'ocean', color: 'blue', revealed: false },
    { word: 'fish', color: 'blue', revealed: false },
    { word: 'lake', color: 'blue', revealed: false },
    { word: 'river', color: 'blue', revealed: false },
    { word: 'pond', color: 'blue', revealed: false },
  ];
  const fetchImpl = async () =>
    geminiResponse([{ clue: 'water', targets: ['ocean', 'fish', 'lake', 'river', 'pond'], reasoning: 'x', risk: 'y' }]);
  const result = await refineClues({ board: wideBoard, yourTeam: 'blue', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.refined[0].count, 4);
});

test('refineClues: invalid JSON from the model falls back gracefully', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }),
  });
  const result = await refineClues({ board, yourTeam: 'blue', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_json');
});

test('refineClues: retries once on a 5xx then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503 };
    return geminiResponse([{ clue: 'water', targets: ['ocean', 'fish'], reasoning: 'x', risk: 'y' }]);
  };
  const result = await refineClues({ board, yourTeam: 'blue', apiKey: 'key', fetchImpl });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
});

test('refineClues: does not retry on a 4xx (e.g. bad key)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 401 };
  };
  const result = await refineClues({ board, yourTeam: 'blue', apiKey: 'key', fetchImpl });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'request_failed');
});
