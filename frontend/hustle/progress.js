/* Unified accessible progress indicators: native <progress>, elapsed/remaining time, staged steps, and global activity tracking. */
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function formatElapsed(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function formatRemaining(seconds, { exceeded = false } = {}) {
    if (exceeded || seconds == null || !Number.isFinite(seconds)) {
      return 'Трохи довше, ніж зазвичай — процес триває';
    }
    const rem = Math.max(0, Math.round(seconds));
    if (rem <= 5) return 'Завершуємо…';
    if (rem < 12) return 'менше 10 с';
    if (rem < 60) {
      const bucket = Math.ceil(rem / 5) * 5;
      return `≈ ${bucket} с`;
    }
    const mins = Math.floor(rem / 60);
    const rest = Math.round((rem % 60) / 10) * 10;
    if (rest >= 60) return `≈ ${mins + 1} хв`;
    if (rest === 0) return `≈ ${mins} хв`;
    return `≈ ${mins} хв ${rest} с`;
  }

  function asymptoticPercent(elapsedSec, expectedSec = 15, floor = 4, ceiling = 94) {
    const t = Math.max(0, Number(elapsedSec) || 0);
    const expected = Math.max(2, Number(expectedSec) || 15);
    // Smooth ease-out curve reaching ~82% at expectedSec, then asymptotically approaching ceiling (never 100% or stalling at 99%).
    const tau = expected / 1.85;
    const raw = floor + (ceiling - floor) * (1 - Math.exp(-t / tau));
    return Math.min(ceiling, Math.max(floor, Math.round(raw)));
  }

  function estimateRemainingSeconds({ elapsedSec, expectedSec, completed = 0, total = 0, perItemSec = 6 }) {
    const elapsed = Math.max(0, Number(elapsedSec) || 0);
    if (total > 0) {
      const remainingItems = Math.max(0, total - completed);
      if (remainingItems === 0) return { remainingSec: 0, exceeded: false };
      if (completed > 0) {
        const measuredPerItem = elapsed / completed;
        const blended = (measuredPerItem * 0.75) + (perItemSec * 0.25);
        return { remainingSec: Math.max(3, remainingItems * blended), exceeded: false };
      }
      const baseline = total * perItemSec;
      if (elapsed >= baseline * 1.15) return { remainingSec: null, exceeded: true };
      return { remainingSec: Math.max(5, baseline - elapsed), exceeded: false };
    }
    const expected = Math.max(3, Number(expectedSec) || 15);
    if (elapsed >= expected * 0.96) return { remainingSec: null, exceeded: true };
    return { remainingSec: Math.max(4, expected - elapsed), exceeded: false };
  }

  function describeEndpoint(path) {
    const p = String(path || '');
    if (p.includes('/prepare-learning')) return 'Генеруємо конспект, картки й тести…';
    if (p.includes('/exam-mix')) return 'Формуємо підготовку до іспиту…';
    if (p.includes('/sync-moodle')) return 'Синхронізуємо курс із Moodle…';
    if (p.includes('/transcribe-video')) return 'Отримуємо транскрипт відео…';
    if (p.includes('/create-text')) return 'Опрацьовуємо навчальні матеріали…';
    if (p.includes('/upload')) return 'Завантажуємо та індексуємо файл…';
    if (p.includes('/preview-structure') || p.includes('/confirm-structure')) return 'Аналізуємо структуру курсу…';
    if (p.includes('/generate')) return 'Оновлюємо конспекти курсу…';
    if (p.includes('/reset')) return 'Скидаємо й оновлюємо курс…';
    if (p.includes('/oral-defense/')) return 'Працює AI-екзаменатор…';
    if (p.includes('/tutor-check')) return 'AI-тютор перевіряє відповідь…';
    if (p.includes('/flashcards')) return 'Готуємо картки повторення…';
    if (p.includes('/quizzes')) return 'Готуємо самоперевірку…';
    if (p.includes('/calendar/ai/')) return 'Складаємо навчальний план у календарі…';
    if (p.includes('/calendar/sync') || p.includes('/sources/')) return 'Синхронізуємо календар…';
    if (p.includes('/calendar/')) return 'Завантажуємо календар…';
    if (p.includes('/api/courses')) return 'Отримуємо курси з Moodle…';
    if (p.includes('/api/workspace/courses')) return 'Завантажуємо курси…';
    if (p.includes('/api/grades')) return 'Завантажуємо оцінки…';
    if (p.includes('/api/assignments')) return 'Завантажуємо дедлайни…';
    return 'Завантажуємо дані…';
  }

  let activeInlineCount = 0;

  function createController(container, options = {}) {
    if (!container || typeof document === 'undefined') {
      return {
        update() {},
        setItemProgress() {},
        setStage() {},
        complete() {},
        fail() {},
        stop() {},
      };
    }

    const stages = Array.isArray(options.stages) && options.stages.length ? options.stages.slice() : [];
    const expectedSec = Number(options.expectedSec) || 0;
    const compact = Boolean(options.compact);
    const perItemSec = Number(options.perItemSec) || 7;
    let total = Math.max(0, Number(options.total) || 0);
    let completed = Math.max(0, Number(options.completed) || 0);
    let title = options.title || stages[0] || 'Виконуємо…';
    let detail = options.detail || '';
    let manualStageIndex = null;
    let maxPercent = 0;
    let itemStartedAt = Date.now();
    const startedAt = Date.now();
    const determinate = total > 0 || expectedSec > 0;
    let stopped = false;

    activeInlineCount++;
    syncGlobalVisibility();

    const card = document.createElement('div');
    card.className = `hp-card${compact ? ' hp-card--compact' : ''}`;
    card.setAttribute('data-hustle-progress', 'active');

    const head = document.createElement('div');
    head.className = 'hp-head';

    const spinner = document.createElement('progress');
    spinner.className = 'loading-spinner';
    spinner.setAttribute('aria-label', 'Процес триває');

    const titleEl = document.createElement('span');
    titleEl.className = 'hp-title';
    titleEl.setAttribute('role', 'status');
    titleEl.setAttribute('aria-live', 'polite');

    const percentEl = document.createElement('span');
    percentEl.className = 'hp-percent';
    percentEl.hidden = !determinate;

    head.append(spinner, titleEl, percentEl);

    const bar = document.createElement('progress');
    bar.className = 'hp-bar';
    bar.setAttribute('aria-label', title);
    if (determinate) {
      bar.max = 100;
      bar.value = 4;
    }

    const detailEl = document.createElement('p');
    detailEl.className = 'hp-detail';
    detailEl.hidden = !detail;

    const meta = document.createElement('div');
    meta.className = 'hp-meta';
    const elapsedEl = document.createElement('span');
    const remainEl = document.createElement('span');
    meta.append(elapsedEl, remainEl);

    card.append(head, bar, detailEl, meta);

    let stepsList = null;
    if (stages.length > 1 && !compact) {
      stepsList = document.createElement('ol');
      stepsList.className = 'hp-steps';
      stepsList.setAttribute('aria-label', 'Етапи виконання');
      card.append(stepsList);
    }

    if (options.append) container.append(card);
    else container.replaceChildren(card);

    function computePercent(elapsedSec) {
      if (total > 0) {
        const base = (completed / total) * 100;
        if (completed >= total) return 100;
        const itemElapsed = (Date.now() - itemStartedAt) / 1000;
        const avgPerItem = completed > 0 ? Math.max(3, elapsedSec / completed) : perItemSec;
        const intraFraction = 0.84 * (1 - Math.exp(-itemElapsed / (avgPerItem * 0.75)));
        const next = Math.min(99, Math.round(base + (intraFraction * 100) / total));
        maxPercent = Math.max(maxPercent, next);
        return maxPercent;
      }
      if (expectedSec > 0) {
        const next = asymptoticPercent(elapsedSec, expectedSec);
        maxPercent = Math.max(maxPercent, next);
        return maxPercent;
      }
      return null;
    }

    function currentStageIndex(pct) {
      if (!stages.length) return -1;
      if (manualStageIndex != null) return Math.min(stages.length - 1, Math.max(0, manualStageIndex));
      if (pct == null) return 0;
      const idx = Math.floor((pct / 95) * stages.length);
      return Math.min(stages.length - 1, Math.max(0, idx));
    }

    function render() {
      if (stopped) return;
      if (!card.isConnected) {
        stop();
        return;
      }
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const pct = computePercent(elapsedSec);
      const stageIdx = currentStageIndex(pct);

      const displayTitle = (manualStageIndex != null && stages[stageIdx])
        ? stages[stageIdx]
        : (options.title || stages[stageIdx] || title);
      titleEl.textContent = displayTitle;
      bar.setAttribute('aria-label', displayTitle);

      if (pct != null) {
        bar.max = 100;
        bar.value = pct;
        percentEl.hidden = false;
        percentEl.textContent = total > 0 ? `${completed}/${total} · ${pct}%` : `${pct}%`;
      } else {
        bar.removeAttribute('value');
        percentEl.hidden = true;
      }

      const activeDetail = detail || (options.title && stages[stageIdx] ? stages[stageIdx] : '');
      detailEl.textContent = activeDetail;
      detailEl.hidden = !activeDetail;

      elapsedEl.innerHTML = `Пройшло: <strong>${esc(formatElapsed(elapsedSec))}</strong>`;

      if (determinate) {
        const est = estimateRemainingSeconds({ elapsedSec, expectedSec, completed, total, perItemSec });
        const remainText = formatRemaining(est.remainingSec, { exceeded: est.exceeded });
        remainEl.innerHTML = est.exceeded
          ? esc(remainText)
          : `Залишилось: <strong>${esc(remainText)}</strong>`;
        remainEl.hidden = false;
      } else {
        remainEl.textContent = elapsedSec >= 4 ? 'Сайт працює — очікуємо відповідь…' : '';
        remainEl.hidden = elapsedSec < 4;
      }

      if (stepsList) {
        stepsList.innerHTML = stages.map((step, i) => {
          const stateClass = i < stageIdx ? 'is-done' : i === stageIdx ? 'is-active' : '';
          const mark = i < stageIdx ? '✓' : i === stageIdx ? '•' : '';
          return `<li class="hp-step ${stateClass}"><span class="hp-step-mark" aria-hidden="true">${mark}</span><span>${esc(step)}</span></li>`;
        }).join('');
      }
    }

    const interval = setInterval(render, 250);
    render();

    function stop({ remove = false } = {}) {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      activeInlineCount = Math.max(0, activeInlineCount - 1);
      syncGlobalVisibility();
      if (remove && card.isConnected) card.remove();
    }

    return {
      element: card,
      update(patch = {}) {
        if (stopped) return;
        if (patch.title != null) title = patch.title;
        if (patch.detail != null) detail = patch.detail;
        if (patch.total != null) total = Math.max(0, Number(patch.total) || 0);
        if (patch.completed != null) {
          const nextCompleted = Math.max(0, Number(patch.completed) || 0);
          if (nextCompleted !== completed) itemStartedAt = Date.now();
          completed = nextCompleted;
        }
        if (patch.stageIndex != null) manualStageIndex = patch.stageIndex;
        render();
      },
      setItemProgress(doneCount, totalCount, itemDetail = '') {
        if (stopped) return;
        const nextDone = Math.max(0, Number(doneCount) || 0);
        if (nextDone !== completed) itemStartedAt = Date.now();
        completed = nextDone;
        if (totalCount != null) total = Math.max(0, Number(totalCount) || 0);
        if (itemDetail != null) detail = itemDetail;
        render();
      },
      setStage(index, customDetail) {
        if (stopped) return;
        manualStageIndex = index;
        if (customDetail != null) detail = customDetail;
        render();
      },
      complete(message = 'Готово') {
        if (stopped) return;
        const elapsedSec = (Date.now() - startedAt) / 1000;
        stop();
        if (!card.isConnected) return;
        card.classList.add('hp-card--done');
        spinner.remove();
        titleEl.textContent = message;
        bar.max = 100;
        bar.value = 100;
        percentEl.hidden = false;
        percentEl.textContent = '100%';
        detailEl.hidden = true;
        elapsedEl.innerHTML = `Завершено за <strong>${esc(formatElapsed(elapsedSec))}</strong>`;
        remainEl.hidden = true;
        if (stepsList) {
          stepsList.innerHTML = stages.map(step =>
            `<li class="hp-step is-done"><span class="hp-step-mark" aria-hidden="true">✓</span><span>${esc(step)}</span></li>`
          ).join('');
        }
      },
      fail(message = 'Не вдалося завершити операцію.') {
        if (stopped) return;
        stop();
        if (!card.isConnected) return;
        card.classList.add('hp-card--error');
        spinner.remove();
        bar.hidden = true;
        percentEl.hidden = true;
        titleEl.setAttribute('role', 'alert');
        titleEl.textContent = message;
        detailEl.hidden = true;
        meta.hidden = true;
        if (stepsList) stepsList.hidden = true;
      },
      stop,
    };
  }

  // Global top activity rail + floating pill for slow untracked UI.api() calls
  const globalRequests = new Map();
  let nextReqId = 0;
  let railEl = null;
  let floatingEl = null;
  let railDelayTimer = null;
  let globalTickTimer = null;

  function ensureGlobalNodes() {
    if (typeof document === 'undefined' || !document.body) return false;
    if (!railEl) {
      railEl = document.createElement('div');
      railEl.className = 'hp-top-rail';
      railEl.hidden = true;
      railEl.innerHTML = '<progress class="hp-bar" aria-label="Завантаження даних"></progress>';
      document.body.append(railEl);
    }
    if (!floatingEl) {
      floatingEl = document.createElement('div');
      floatingEl.className = 'hp-floating';
      floatingEl.hidden = true;
      floatingEl.setAttribute('role', 'status');
      floatingEl.setAttribute('aria-live', 'polite');
      floatingEl.innerHTML = `<div class="hp-head"><progress class="loading-spinner" aria-label="Виконується запит"></progress><span class="hp-title" data-hp-float-title></span></div><progress class="hp-bar" aria-label="Прогрес запиту"></progress><div class="hp-meta"><span data-hp-float-elapsed></span><span data-hp-float-count></span></div>`;
      document.body.append(floatingEl);
    }
    return true;
  }

  function syncGlobalVisibility() {
    if (!ensureGlobalNodes()) return;
    if (!globalRequests.size) {
      clearTimeout(railDelayTimer);
      railDelayTimer = null;
      clearInterval(globalTickTimer);
      globalTickTimer = null;
      railEl.hidden = true;
      floatingEl.hidden = true;
      return;
    }

    const now = Date.now();
    let oldest = null;
    for (const req of globalRequests.values()) {
      if (!oldest || req.startedAt < oldest.startedAt) oldest = req;
    }
    const elapsedSec = (now - oldest.startedAt) / 1000;

    if (elapsedSec >= 0.18) {
      railEl.hidden = false;
    }

    // Show floating status pill only for requests > 2.5s when no inline progress card is already displayed
    if (elapsedSec >= 2.5 && activeInlineCount === 0) {
      floatingEl.hidden = false;
      floatingEl.querySelector('[data-hp-float-title]').textContent = oldest.label;
      floatingEl.querySelector('[data-hp-float-elapsed]').innerHTML = `Пройшло: <strong>${esc(formatElapsed(elapsedSec))}</strong>`;
      const extra = globalRequests.size > 1 ? `Активних запитів: ${globalRequests.size}` : 'Сайт працює…';
      floatingEl.querySelector('[data-hp-float-count]').textContent = extra;
    } else {
      floatingEl.hidden = true;
    }
  }

  function trackRequest(path, label) {
    if (typeof document === 'undefined') return () => {};
    const id = ++nextReqId;
    globalRequests.set(id, {
      startedAt: Date.now(),
      label: label || describeEndpoint(path),
    });

    if (!railDelayTimer && globalRequests.size === 1) {
      railDelayTimer = setTimeout(() => {
        railDelayTimer = null;
        syncGlobalVisibility();
      }, 190);
    }
    if (!globalTickTimer) {
      globalTickTimer = setInterval(syncGlobalVisibility, 400);
    }

    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      globalRequests.delete(id);
      syncGlobalVisibility();
    };
  }

  function mount(container, options = {}) {
    return createController(container, options);
  }

  function renderStaticLoading(title = 'Завантажуємо…', detail = '') {
    return `<div class="hp-card hp-card--compact"><div class="hp-head"><progress class="loading-spinner" aria-label="${esc(title)}"></progress><span class="hp-title" role="status">${esc(title)}</span></div><progress class="hp-bar" aria-label="${esc(title)}"></progress>${detail ? `<p class="hp-detail">${esc(detail)}</p>` : ''}</div>`;
  }

  const api = {
    mount,
    trackRequest,
    renderStaticLoading,
    formatElapsed,
    formatRemaining,
    asymptoticPercent,
    estimateRemainingSeconds,
    describeEndpoint,
  };

  if (typeof window !== 'undefined') window.HustleProgress = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
