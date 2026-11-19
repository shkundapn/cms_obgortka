const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

const source = readFileSync(require.resolve('../../frontend/prototype/rewards.js'), 'utf8');
const original = ['deadline', 'notes', 'search', 'quiz', 'quiz-start', 'quiz-correction', 'flashcard-flip', 'review-due', 'oral-practice'];
const scenes = ['trail-map', 'paper-plane', 'book-fort', 'card-trick', 'lucky-die', 'headphones', 'pencil-race', 'nap-notes'];
const found = (ids) => Object.fromEntries(ids.map(id => [id, true]));

function start(initial) {
  let stored = JSON.stringify(initial);
  const window = { Hustle: { account: { owner: 'test' }, escape: String, icon: () => '' }, addEventListener() {} };
  const document = {
    createElement: () => ({ setAttribute() {} }),
    querySelector: () => ({ before() {} }),
    querySelectorAll: () => [],
    body: { dataset: {}, append() {} },
    addEventListener() {},
  };
  const localStorage = {
    getItem: () => stored,
    setItem: (_, value) => { stored = value; },
  };
  runInNewContext(source, {
    document, window, localStorage, navigator: {}, UI: { countLabel: String },
    setTimeout: () => 0, clearTimeout() {},
  });
  return { rewards: window.HustleRewards, data: () => JSON.parse(stored) };
}

function markerButton(id) {
  const attrs = new Map();
  const badge = { textContent: '✦' };
  return {
    dataset: { rewardFind: id },
    isConnected: true,
    classList: { contains: (name) => name === 'reward-donkey--scene' },
    hasAttribute: (key) => attrs.has(key),
    setAttribute: (key, value) => attrs.set(key, value),
    toggleAttribute: (key, value) => attrs.set(key, value),
    querySelector: () => badge,
  };
}

test('the new album keeps existing finds and an earned avatar after the first new find', async () => {
  const { rewards, data } = start({ albumVersion: 2, found: found(original), equipped: { avatar: 'avatar-champion' } });
  assert.match(rewards.renderShop('rewards/collection'), /9\/17 знайдено/);
  assert.equal(rewards.activeAvatar().id, 'avatar-champion');

  await rewards.find(markerButton('trail-map'));
  assert.equal(data().albumVersion, 3);
  assert.equal(data().unlocked['avatar-champion'], true);
  assert.equal(data().unlocked.library, true);
  assert.equal(rewards.activeAvatar().id, 'avatar-champion');
  assert.match(rewards.renderShop('rewards/collection'), /10\/17 знайдено/);
});

test('a partial album earns the champion once the final sticker is found', async () => {
  const last = scenes.at(-1);
  const { rewards, data } = start({ albumVersion: 3, found: found([...original, ...scenes.slice(0, -1)]), equipped: { avatar: 'avatar-champion' } });
  assert.equal(rewards.activeAvatar(), undefined);
  assert.match(rewards.marker(last), /nap-notes\.webp/);

  const button = markerButton(last);
  await Promise.all([rewards.find(button), rewards.find(button)]);
  assert.equal(Object.keys(data().found).length, 17);
  assert.equal(rewards.marker(last), '');
  assert.equal(rewards.activeAvatar().id, 'avatar-champion');
  assert.match(rewards.renderShop('rewards/collection'), /17\/17 знайдено/);
});
