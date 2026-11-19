const test = require('node:test');
const assert = require('node:assert/strict');
const progress = require('../../frontend/hustle/progress.js');

test('formatElapsed formats seconds into mm:ss without negative values', () => {
  assert.equal(progress.formatElapsed(0), '0:00');
  assert.equal(progress.formatElapsed(-5), '0:00');
  assert.equal(progress.formatElapsed(9), '0:09');
  assert.equal(progress.formatElapsed(65), '1:05');
  assert.equal(progress.formatElapsed(125.9), '2:05');
});

test('formatRemaining uses human-friendly buckets and honest overrun copy', () => {
  assert.equal(progress.formatRemaining(3), 'Завершуємо…');
  assert.equal(progress.formatRemaining(9), 'менше 10 с');
  assert.equal(progress.formatRemaining(22), '≈ 25 с');
  assert.equal(progress.formatRemaining(75), '≈ 1 хв 20 с');
  assert.equal(progress.formatRemaining(null, { exceeded: true }), 'Трохи довше, ніж зазвичай — процес триває');
});

test('asymptoticPercent is monotonic and never reaches 100% or stalls at 99%', () => {
  let prev = 0;
  for (const t of [0, 1, 3, 8, 15, 30, 60, 180, 600]) {
    const pct = progress.asymptoticPercent(t, 20);
    assert.ok(pct >= prev, `expected monotonic progress at t=${t}: ${pct} >= ${prev}`);
    assert.ok(pct >= 4 && pct <= 94, `expected bounded progress at t=${t}: ${pct}`);
    prev = pct;
  }
});

test('estimateRemainingSeconds computes determinate ETA and switches honestly on overrun', () => {
  const mid = progress.estimateRemainingSeconds({ elapsedSec: 16, completed: 2, total: 5, perItemSec: 8 });
  assert.equal(mid.exceeded, false);
  assert.ok(mid.remainingSec >= 20 && mid.remainingSec <= 30);

  const done = progress.estimateRemainingSeconds({ elapsedSec: 40, completed: 5, total: 5, perItemSec: 8 });
  assert.equal(done.exceeded, false);
  assert.equal(done.remainingSec, 0);

  const overrun = progress.estimateRemainingSeconds({ elapsedSec: 30, expectedSec: 25 });
  assert.equal(overrun.exceeded, true);
  assert.equal(overrun.remainingSec, null);
});

test('describeEndpoint returns clear Ukrainian descriptions for long-running endpoints', () => {
  assert.match(progress.describeEndpoint('/api/workspace/courses/1/topics/2/prepare-learning'), /конспект/i);
  assert.match(progress.describeEndpoint('/api/workspace/courses/1/sync-moodle'), /Moodle/);
  assert.match(progress.describeEndpoint('/api/calendar/ai/plan'), /календар/i);
  assert.match(progress.describeEndpoint('/api/workspace/courses/1/topics/2/oral-defense/evaluate'), /AI-екзаменатор/);
});
