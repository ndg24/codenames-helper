import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctWords } from '../src/ocrCorrect.mjs';

const BANK = ['Ocean', 'Africa', 'Agent', 'Robot', 'Train', 'Trail'];

test('correctWords: exact bank match is left alone and not flagged', () => {
  const { words, corrected } = correctWords(['OCEAN'], BANK);
  assert.deepEqual(words, ['OCEAN']);
  assert.deepEqual(corrected, [false]);
});

test('correctWords: snaps a single-letter OCR misread to its unique closest bank word', () => {
  const { words, corrected } = correctWords(['OCEAM'], BANK);
  assert.deepEqual(words, ['OCEAN']);
  assert.deepEqual(corrected, [true]);
});

test('correctWords: leaves an ambiguous tie between equally-close bank words untouched', () => {
  // "TRAIL"/"TRAIN" are both distance 1 from "TRAIM" — ambiguous, don't guess.
  const { words, corrected } = correctWords(['TRAIM'], BANK);
  assert.deepEqual(words, ['TRAIM']);
  assert.deepEqual(corrected, [false]);
});

test('correctWords: leaves a word too far from any bank entry untouched', () => {
  const { words, corrected } = correctWords(['ZEBRA'], BANK);
  assert.deepEqual(words, ['ZEBRA']);
  assert.deepEqual(corrected, [false]);
});

test('correctWords: never corrects an empty (unreadable) cell', () => {
  const { words, corrected } = correctWords([''], BANK);
  assert.deepEqual(words, ['']);
  assert.deepEqual(corrected, [false]);
});

test('correctWords: never corrects very short words even with a plausible neighbor', () => {
  const { words, corrected } = correctWords(['GO'], ['Go', 'So']);
  assert.deepEqual(words, ['GO']);
  assert.deepEqual(corrected, [false]);
});

test('correctWords: no-op when bank is empty or omitted', () => {
  assert.deepEqual(correctWords(['0CEAN'], []).words, ['0CEAN']);
  assert.deepEqual(correctWords(['0CEAN']).words, ['0CEAN']);
});

test('correctWords: preserves order and length across a mixed board row', () => {
  const { words, corrected } = correctWords(['OCEAM', 'AFRICA', '', 'ZEBRA'], BANK);
  assert.deepEqual(words, ['OCEAN', 'AFRICA', '', 'ZEBRA']);
  assert.deepEqual(corrected, [true, false, false, false]);
});
