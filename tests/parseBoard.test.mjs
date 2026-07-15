import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoard } from '../server/parseBoard.mjs';

function anthropicResponse(words) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'tool_use', name: 'report_words', input: { words } }],
    }),
  };
}

const FULL_25 = Array.from({ length: 25 }, (_, i) => `WORD${i}`);

test('parseBoard: not_configured when no API key', async () => {
  const result = await parseBoard({ imageBase64: 'abc', mimeType: 'image/jpeg', apiKey: undefined });
  assert.deepEqual(result, { ok: false, reason: 'not_configured' });
});

test('parseBoard: invalid_image on missing image data', async () => {
  const result = await parseBoard({ imageBase64: '', mimeType: 'image/jpeg', apiKey: 'key' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_image');
});

test('parseBoard: invalid_image on disallowed mime type', async () => {
  const result = await parseBoard({ imageBase64: 'abc', mimeType: 'image/gif', apiKey: 'key' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_image');
});

test('parseBoard: returns normalized uppercase words on success', async () => {
  const fetchImpl = async () => anthropicResponse(FULL_25.map((w) => w.toLowerCase()));
  const result = await parseBoard({ imageBase64: 'abc', mimeType: 'image/jpeg', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.words.length, 25);
  assert.deepEqual(result.words, FULL_25);
});

test('parseBoard: pads short word lists to 25', async () => {
  const fetchImpl = async () => anthropicResponse(FULL_25.slice(0, 23));
  const result = await parseBoard({ imageBase64: 'abc', mimeType: 'image/jpeg', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.words.length, 25);
  assert.equal(result.words[23], '');
  assert.equal(result.words[24], '');
});

test('parseBoard: truncates long word lists to 25', async () => {
  const fetchImpl = async () => anthropicResponse([...FULL_25, 'EXTRA', 'EXTRA2']);
  const result = await parseBoard({ imageBase64: 'abc', mimeType: 'image/jpeg', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.words.length, 25);
  assert.deepEqual(result.words, FULL_25);
});

test('parseBoard: empty_response when no tool_use block returned', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'sorry' }] }) });
  const result = await parseBoard({ imageBase64: 'abc', mimeType: 'image/jpeg', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty_response');
});

test('parseBoard: invalid_shape when tool input.words is not an array', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'tool_use', name: 'report_words', input: { words: 'nope' } }] }),
  });
  const result = await parseBoard({ imageBase64: 'abc', mimeType: 'image/jpeg', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_shape');
});

test('parseBoard: retries once on 5xx then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503 };
    return anthropicResponse(FULL_25);
  };
  const result = await parseBoard({ imageBase64: 'abc', mimeType: 'image/jpeg', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('parseBoard: does not retry on 4xx', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 401 };
  };
  const result = await parseBoard({ imageBase64: 'abc', mimeType: 'image/jpeg', apiKey: 'key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'request_failed');
  assert.equal(calls, 1);
});
