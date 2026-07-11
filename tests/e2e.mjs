// Smoke test: fills a real 25-word board, generates clues, and checks the
// happy path renders. Requires `npm run serve` running on localhost:8080
// and `npx playwright install chromium` done at least once.
//
// This is opt-in (not part of `npm test`) since it needs network access to
// fetch transformers.js + the MiniLM model weights from the CDN on first run.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

const BOARD = [
  ['FISH', 'blue'], ['OVEN', 'blue'], ['BULB', 'blue'], ['LIGHT', 'blue'], ['LASER', 'blue'],
  ['BOOK', 'blue'], ['CAMERA', 'blue'], ['TELESCOPE', 'blue'], ['POST', 'blue'],
  ['GERMANY', 'red'], ['ENGLAND', 'red'], ['KING ARTHUR', 'red'], ['CLASSROOM', 'red'],
  ['JUMPER', 'red'], ['SHORTS', 'red'], ['SOAP', 'red'], ['ROPE', 'red'],
  ['TIME', 'neutral'], ['ROSE', 'neutral'], ['CHIP', 'neutral'], ['SPRING', 'neutral'],
  ['BOX', 'neutral'], ['PARROT', 'neutral'], ['STAMP', 'neutral'],
  ['LINE', 'assassin'],
];

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(BASE_URL);

const cells = await page.$$('.board-cell');
assert.equal(cells.length, 25, `expected 25 board cells, got ${cells.length}`);

for (let i = 0; i < BOARD.length; i++) {
  const [word, color] = BOARD[i];
  await cells[i].$eval('input', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, word);
  await cells[i].$eval(`.swatch.${color}`, (el) => el.click());
}

assert.equal(await page.locator('#getCluesBtn').isDisabled(), false, '"Get clues" should be enabled once the board is complete');

await page.click('#getCluesBtn');
await page.waitForSelector('#screen-clues.active', { timeout: 120000 });
await page.waitForSelector('.clue-row', { timeout: 120000 });

const clueCount = await page.locator('.clue-row').count();
assert.ok(clueCount > 0, 'expected at least one ranked clue');

await page.click('#backToBoardBtn');
await page.waitForSelector('#screen-board.active');
const preserved = await page.$eval('.board-cell input', (el) => el.value);
assert.equal(preserved, 'FISH', 'board state should survive navigating back');

assert.equal(consoleErrors.length, 0, `console errors: ${consoleErrors.join(', ')}`);

await browser.close();
console.log(`e2e OK — ${clueCount} clues generated, no console errors`);
