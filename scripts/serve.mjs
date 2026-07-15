import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../server/env.mjs';
import { refineClues } from '../server/refineClues.mjs';
import { parseBoard } from '../server/parseBoard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const port = process.env.PORT || 8080;
const MAX_REFINE_BODY_BYTES = 50_000;
// Client-side compression targets ~1568px/JPEG-0.85 before sending, but allow headroom
// for the base64 inflation (~33%) plus JSON framing.
const MAX_PARSE_BODY_BYTES = 6_000_000;

loadEnvFile(path.join(root, '.env'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleRefineClues(req, res) {
  let bodyText;
  try {
    bodyText = await readBody(req, MAX_REFINE_BODY_BYTES);
  } catch {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'payload_too_large' }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'invalid_json' }));
    return;
  }

  const { board, yourTeam } = payload || {};
  if (!Array.isArray(board) || typeof yourTeam !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'invalid_shape' }));
    return;
  }

  const result = await refineClues({
    board,
    yourTeam,
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

async function handleParseBoard(req, res) {
  let bodyText;
  try {
    bodyText = await readBody(req, MAX_PARSE_BODY_BYTES);
  } catch {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'payload_too_large' }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'invalid_json' }));
    return;
  }

  const { imageBase64, mimeType } = payload || {};
  if (typeof imageBase64 !== 'string' || typeof mimeType !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'invalid_shape' }));
    return;
  }

  const result = await parseBoard({
    imageBase64,
    mimeType,
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/refine-clues') {
    try {
      await handleRefineClues(req, res);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'internal_error' }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/parse-board') {
    try {
      await handleParseBoard(req, res);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'internal_error' }));
    }
    return;
  }

  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(root, relPath));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}`);
});
