import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWord, cosineSim, rankClues } from '../src/scoring.mjs';

function unit(v) {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / mag);
}

test('normalizeWord lowercases and strips non-letters', () => {
  assert.equal(normalizeWord('  King Arthur! '), 'kingarthur');
  assert.equal(normalizeWord('Snow-Man'), 'snowman');
});

test('cosineSim: identical vectors = 1, orthogonal = 0, opposite = -1', () => {
  assert.equal(cosineSim([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSim([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosineSim([1, 0, 0], [-1, 0, 0]), -1);
});

test('rankClues excludes a candidate that exactly matches a board word', () => {
  const board = [{ word: 'alpha', color: 'blue' }];
  const boardEmbeddings = [{ word: 'alpha', norm: 'alpha', vector: [1, 0, 0] }];
  const wordVectors = [{ word: 'alpha', norm: 'alpha', vector: [1, 0, 0] }];
  const results = rankClues({ board, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { maxCount: 1 });
  assert.equal(results.length, 0);
});

test('rankClues excludes a candidate that is a substring/superstring of a board word', () => {
  const board = [{ word: 'snowman', color: 'blue' }];
  const boardEmbeddings = [{ word: 'snowman', norm: 'snowman', vector: [1, 0, 0] }];
  const wordVectors = [
    { word: 'snow', norm: 'snow', vector: [0.9, 0.1, 0] },      // substring of "snowman"
    { word: 'snowmanlike', norm: 'snowmanlike', vector: [0.9, 0, 0.1] }, // superstring
    { word: 'winter', norm: 'winter', vector: [0.5, 0.5, 0] },  // unrelated string, legal
  ];
  const results = rankClues({ board, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { minCount: 1, maxCount: 1 });
  assert.deepEqual(results.map((r) => r.clue), ['winter']);
});

test('rankClues weighs assassin proximity as riskier than opponent, and opponent riskier than neutral', () => {
  const alpha = { word: 'alpha', vector: [1, 0, 0] };
  const danger = { word: 'danger', vector: unit([1, 1, 0]) }; // equal raw similarity to alpha in every case
  const candidate = [{ word: 'candidate', norm: 'candidate', vector: unit([1, 1, 0]) }];

  const scoreWithDangerColor = (color) => {
    const board = [{ word: alpha.word, color: 'blue' }, { word: danger.word, color }];
    const boardEmbeddings = [
      { word: alpha.word, norm: 'alpha', vector: alpha.vector },
      { word: danger.word, norm: 'danger', vector: danger.vector },
    ];
    const [result] = rankClues({ board, yourTeam: 'blue' }, candidate, boardEmbeddings, { minCount: 1, maxCount: 1 });
    return result.score;
  };

  const neutralScore = scoreWithDangerColor('neutral');
  const opponentScore = scoreWithDangerColor('red');
  const assassinScore = scoreWithDangerColor('assassin');

  assert.ok(neutralScore > opponentScore, `expected neutral (${neutralScore}) > opponent (${opponentScore})`);
  assert.ok(opponentScore > assassinScore, `expected opponent (${opponentScore}) > assassin (${assassinScore})`);
});

test('rankClues picks the count with the best score, not always the max', () => {
  const board = [
    { word: 'close', color: 'blue' },
    { word: 'far', color: 'blue' },
  ];
  const boardEmbeddings = [
    { word: 'close', norm: 'close', vector: [1, 0, 0] },
    { word: 'far', norm: 'far', vector: unit([0.2, 1, 0]) }, // much less similar to the candidate
  ];
  const wordVectors = [{ word: 'candidate', norm: 'candidate', vector: [1, 0, 0] }];

  const [result] = rankClues({ board, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { minCount: 1, maxCount: 2 });
  assert.equal(result.count, 1);
  assert.deepEqual(result.targetWords, ['close']);
});

test('rankClues excludes revealed own-team words from coverage targets', () => {
  const board = [
    { word: 'close', color: 'blue', revealed: true },
    { word: 'far', color: 'blue' },
  ];
  const boardEmbeddings = [
    { word: 'close', norm: 'close', vector: [1, 0, 0] },
    { word: 'far', norm: 'far', vector: unit([0.2, 1, 0]) },
  ];
  const wordVectors = [{ word: 'candidate', norm: 'candidate', vector: [1, 0, 0] }];

  const [result] = rankClues({ board, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { minCount: 1, maxCount: 2 });
  assert.deepEqual(result.targetWords, ['far']);
});

test('rankClues ignores revealed danger words when computing risk', () => {
  const board = [
    { word: 'alpha', color: 'blue' },
    { word: 'bomb', color: 'assassin', revealed: true },
  ];
  const boardEmbeddings = [
    { word: 'alpha', norm: 'alpha', vector: [1, 0, 0] },
    { word: 'bomb', norm: 'bomb', vector: unit([1, 1, 0]) },
  ];
  const wordVectors = [{ word: 'candidate', norm: 'candidate', vector: unit([1, 1, 0]) }];

  const [result] = rankClues({ board, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { minCount: 1, maxCount: 1 });
  assert.equal(result.riskWord, null);
});

test('rankClues returns no candidates once every own-team word is revealed', () => {
  const board = [{ word: 'alpha', color: 'blue', revealed: true }];
  const boardEmbeddings = [{ word: 'alpha', norm: 'alpha', vector: [1, 0, 0] }];
  const wordVectors = [{ word: 'candidate', norm: 'candidate', vector: [1, 0, 0] }];
  const results = rankClues({ board, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { maxCount: 1 });
  assert.deepEqual(results, []);
});

test('rankClues prefers a higher count when several own words are all closely related', () => {
  const board = [
    { word: 'one', color: 'blue' },
    { word: 'two', color: 'blue' },
    { word: 'three', color: 'blue' },
  ];
  const boardEmbeddings = [
    { word: 'one', norm: 'one', vector: unit([1, 0.1, 0]) },
    { word: 'two', norm: 'two', vector: unit([1, 0.2, 0]) },
    { word: 'three', norm: 'three', vector: unit([1, 0.3, 0]) },
  ];
  const wordVectors = [{ word: 'candidate', norm: 'candidate', vector: [1, 0, 0] }];

  const [result] = rankClues({ board, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { maxCount: 4 });
  assert.equal(result.count, 3);
  assert.deepEqual(result.targetWords, ['one', 'two', 'three']);
});

test('rankClues drops a candidate rather than pad a weak word into its minimum count', () => {
  const board = [
    { word: 'close', color: 'blue' },
    { word: 'far', color: 'blue' },
  ];
  const boardEmbeddings = [
    { word: 'close', norm: 'close', vector: [1, 0, 0] },
    { word: 'far', norm: 'far', vector: unit([0.1, 1, 0]) }, // sim ~0.1, below MIN_TARGET_SIM
  ];
  const wordVectors = [{ word: 'candidate', norm: 'candidate', vector: [1, 0, 0] }];

  // Default minCount is 2, but "far" is too weak to legitimately fill the second slot —
  // the candidate should be dropped entirely, not offered as a (banned) single-word clue.
  const results = rankClues({ board, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { maxCount: 2 });
  assert.deepEqual(results, []);
});

test('rankClues never returns a count below minCount (default 2)', () => {
  const board = [{ word: 'alpha', color: 'blue' }];
  const boardEmbeddings = [{ word: 'alpha', norm: 'alpha', vector: [1, 0, 0] }];
  const wordVectors = [{ word: 'candidate', norm: 'candidate', vector: [1, 0, 0] }];

  // Only one own-team word remains, so no candidate can reach the minimum count of 2.
  const results = rankClues({ board, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { maxCount: 4 });
  assert.deepEqual(results, []);
});

test('rankClues sorts by score descending and respects topN', () => {
  const board = [{ word: 'alpha', color: 'blue' }];
  const boardEmbeddings = [{ word: 'alpha', norm: 'alpha', vector: [1, 0, 0] }];
  const wordVectors = [
    { word: 'best', norm: 'best', vector: [1, 0, 0] },
    { word: 'mid', norm: 'mid', vector: unit([1, 0.5, 0]) },
    { word: 'worst', norm: 'worst', vector: unit([1, 1, 1]) },
  ];
  const results = rankClues({ board, yourTeam: 'blue' }, wordVectors, boardEmbeddings, { minCount: 1, maxCount: 1, topN: 2 });
  assert.equal(results.length, 2);
  assert.equal(results[0].clue, 'best');
  assert.equal(results[1].clue, 'mid');
});
