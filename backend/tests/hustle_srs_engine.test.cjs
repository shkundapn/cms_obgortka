const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '../..');
const srsBundlePath = path.join(repoRoot, 'frontend/hustle/vendor/srs-engine.js');

function loadSRSEngine() {
  const code = fs.readFileSync(srsBundlePath, 'utf8');
  const store = new Map();
  const sandbox = {
    window: {},
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Error,
    console,
  };
  vm.runInNewContext(code, sandbox);
  return sandbox.window.HustleSRSEngine;
}

test('ts-fsrs is strictly isolated inside frontend/src/services/srsEngine.ts', () => {
  const frontendDir = path.join(repoRoot, 'frontend');
  const matches = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'vendor', 'legacy-midterm'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx|cjs|mjs)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes('ts-fsrs')) {
          matches.push(path.relative(frontendDir, full));
        }
      }
    }
  }

  walk(frontendDir);
  assert.deepEqual(matches, [path.join('src', 'services', 'srsEngine.ts')]);
});

test('srsEngine calibrates retention goal and daily new-card limits from time budget', () => {
  const srs = loadSRSEngine();
  assert.ok(srs, 'HustleSRSEngine should attach to window');

  const shortDay = srs.calibrateGoalAndTime({
    targetRetention: 0.90,
    dailyMinutes: 10,
    avgSecondsPerCard: 20,
  });
  const longDay = srs.calibrateGoalAndTime({
    targetRetention: 0.90,
    dailyMinutes: 40,
    avgSecondsPerCard: 20,
  });
  const strictGoal = srs.calibrateGoalAndTime({
    targetRetention: 0.97,
    dailyMinutes: 20,
    avgSecondsPerCard: 20,
  });
  const relaxedGoal = srs.calibrateGoalAndTime({
    targetRetention: 0.85,
    dailyMinutes: 20,
    avgSecondsPerCard: 20,
  });

  assert.equal(shortDay.requestRetention, 0.9);
  assert.ok(longDay.newCardsLimit > shortDay.newCardsLimit);
  assert.ok(strictGoal.newCardsLimit <= relaxedGoal.newCardsLimit);
  assert.equal(strictGoal.requestRetention, 0.97);
});

test('srsEngine schedules previews and state transitions cleanly through ts-fsrs', () => {
  const srs = loadSRSEngine();
  const now = new Date('2026-11-19T10:00:00Z');
  const card = srs.createCard({
    id: 'card-bayes-1',
    front: 'Що таке формула Баєса?',
    back: '$$P(H|E) = \\frac{P(E|H)P(H)}{P(E)}$$',
    courseId: 101,
    courseTitle: 'Ймовірність',
    now,
  });

  assert.equal(card.state, 'new');
  const preview = srs.getSchedulingPreview(card, { targetRetention: 0.90, learningSteps: [1, 10] }, now);
  assert.ok(preview.again.intervalLabel);
  assert.ok(preview.hard.intervalLabel);
  assert.ok(preview.good.intervalLabel);
  assert.ok(preview.easy.intervalLabel);
  assert.ok(preview.easy.intervalDays >= preview.good.intervalDays);
  assert.ok(preview.good.intervalDays >= preview.again.intervalDays);

  const afterEasy = srs.reviewCard(card, 'easy', { targetRetention: 0.90 }, now);
  assert.equal(afterEasy.previousState, 'new');
  assert.equal(afterEasy.nextState, 'review');
  assert.ok(afterEasy.intervalDays >= 1);

  const payload = srs.toBackendReviewPayload(afterEasy, 9500);
  assert.equal(payload.card_key, 'card-bayes-1');
  assert.equal(payload.card_state, 'review');
  assert.equal(payload.review_duration_ms, 9500);
  assert.ok(payload.fsrs_state && typeof payload.fsrs_state === 'object');

  const decks = srs.computeCourseDecks([card, afterEasy.card], [{ course_id: 101, title: 'Ймовірність' }], now);
  assert.equal(decks.length, 1);
  assert.equal(decks[0].newCount, 1);
  assert.equal(decks[0].masteredCount, 1);
  assert.equal(decks[0].progressPercent, 50);
});
