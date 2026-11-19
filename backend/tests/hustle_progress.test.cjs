const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const progress = require('../../frontend/hustle/progress.js');
const progressSource = readFileSync(require.resolve('../../frontend/hustle/progress.js'), 'utf8');

test('formatElapsed formats seconds into mm:ss without negative values', () => {
  assert.equal(progress.formatElapsed(0), '0:00');
  assert.equal(progress.formatElapsed(-5), '0:00');
  assert.equal(progress.formatElapsed(9), '0:09');
  assert.equal(progress.formatElapsed(65), '1:05');
  assert.equal(progress.formatElapsed(125.9), '2:05');
});

test('formatRemaining uses human-friendly buckets and honest overrun copy', () => {
  assert.equal(progress.formatRemaining(3), 'менше 10 с');
  assert.equal(progress.formatRemaining(9), 'менше 10 с');
  assert.equal(progress.formatRemaining(10), '≈ 10 с');
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

test('short requests stay quiet and overlapping work shares one progress bar', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const nodes = [];
  const document = {
    body: { append: (...elements) => nodes.push(...elements) },
    createElement: () => ({ dataset: {}, setAttribute() {} }),
  };
  const window = {};
  runInNewContext(progressSource, { window, document, Date, setTimeout, clearTimeout, setInterval, clearInterval });
  const { trackRequest, trackPageActivity } = window.HustleProgress;

  const finishQuick = trackRequest('/api/calendar/overview');
  t.mock.timers.tick(150);
  finishQuick();
  t.mock.timers.tick(600);
  const bar = nodes.find(node => node.className === 'hp-page-progress');
  const isActive = () => bar.dataset.active === 'true';
  assert.equal(isActive(), false);

  const finishFirst = trackRequest('/api/assignments');
  let connected = true;
  trackPageActivity('Відкриваємо курс…', () => connected);
  t.mock.timers.tick(179);
  assert.equal(isActive(), false);
  t.mock.timers.tick(1);
  assert.equal(isActive(), true);
  assert.equal(nodes.filter(node => node.className === 'hp-page-progress').length, 1);
  finishFirst();
  t.mock.timers.tick(600);
  assert.equal(isActive(), true);

  connected = false;
  t.mock.timers.tick(400);
  const finishJoined = trackRequest('/api/workspace/courses');
  assert.equal(isActive(), true);
  finishJoined();
  t.mock.timers.tick(400);
  assert.equal(isActive(), false);
});

const uiSource = readFileSync(require.resolve('../../frontend/hustle/ui.js'), 'utf8');

test('request tracking spans the 401 retry and the 502 extension fallback', async () => {
  const actions = [];
  const path = '/api/assignments';
  const window = { HustleProgress: { trackRequest(url) {
    actions.push(`start ${url}`);
    return () => actions.push('finish');
  } } };
  const statuses = [401, 502];
  const fetch = async url => {
    actions.push(`fetch ${url}`);
    return { status: statuses.shift() };
  };
  runInNewContext(uiSource, { window, fetch });
  window.UI.refreshSession = async () => { actions.push('refresh'); return true; };
  const assignments = { assignments: [] };
  window.UI.fallbackViaExtension = async url => {
    actions.push(`extension ${url}`);
    return assignments;
  };

  assert.equal(await window.UI.api(path), assignments);
  assert.deepEqual(actions, [
    `start ${path}`, `fetch ${path}`, 'refresh', `fetch ${path}`, `extension ${path}`, 'finish',
  ]);
});

test('transport errors release the request tracker', async () => {
  let finishes = 0;
  const window = { HustleProgress: { trackRequest: () => () => { finishes++; } } };
  const error = new Error('Network unavailable');
  runInNewContext(uiSource, { window, fetch: async () => { throw error; } });

  await assert.rejects(window.UI.api('/api/workspace/courses'), error);
  assert.equal(finishes, 1);
});
