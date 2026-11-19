/* Comprehensive Anki Spaced Repetition Module (powered exclusively through HustleSRSEngine) */
(() => {
  const { escape: esc, icon } = UI;
  const THEME_KEY = 'hustle-anki-theme-v1';

  let lastSession = null;
  let activeDashboardHost = null;
  let activePageHost = null;
  let activeAccount = null;

  const studyState = {
    courseId: null,
    practiceAll: false,
    queue: [],
    idx: 0,
    revealed: false,
    cardStartedAt: 0,
    sessionStartedAt: 0,
    reviewedInSession: 0,
    ratingsCount: { again: 0, hard: 0, good: 0, easy: 0 },
    busy: false,
    complete: false,
  };

  function engine() {
    return window.HustleSRSEngine;
  }

  function ownerId() {
    return activeAccount?.owner_id || 'guest';
  }

  function getThemePreference() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {}
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(el, nextTheme) {
    const theme = nextTheme || getThemePreference();
    if (el) el.dataset.ankiTheme = theme;
    try {
      if (nextTheme) localStorage.setItem(THEME_KEY, nextTheme);
    } catch {}
    return theme;
  }

  function renderRich(value) {
    const raw = String(value || '');
    if (UI.markdown) return UI.markdown(raw);
    return esc(raw).replace(/\n/g, '<br>');
  }

  function renderInline(value) {
    return UI.inlineMath ? UI.inlineMath(String(value || '')) : esc(String(value || ''));
  }

  async function apiReq(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(typeof data?.detail === 'string' ? data.detail : 'Не вдалося оновити Anki.');
    }
    return data;
  }

  function activeConfig(session) {
    const srs = engine();
    const server = session?.settings || {};
    const local = srs?.loadLocalConfig?.(ownerId()) || {};
    const merged = { ...local, ...server };
    return srs ? srs.normalizeConfig(merged) : merged;
  }

  function activeMetrics(session) {
    const srs = engine();
    const local = srs?.loadLocalMetrics?.(ownerId()) || { avgSecondsPerCard: 18, streakDays: 0 };
    const serverStreak = Number(session?.stats?.study_streak || 0);
    return {
      ...local,
      streakDays: Math.max(serverStreak, Number(local.streakDays || 0)),
    };
  }

  function allCardsFromSession(session) {
    const raw = session?.cards?.length ? session.cards : session?.queue || [];
    const srs = engine();
    return srs ? raw.map(c => srs.fromBackendCard(c)) : raw;
  }

  function courseDecksFromSession(session) {
    const srs = engine();
    const cards = allCardsFromSession(session);
    const courses = session?.courses || [];
    if (srs) return srs.computeCourseDecks(cards, courses);
    return courses.map(c => ({
      courseId: Number(c.course_id),
      title: c.title,
      newCount: Number(c.new_count || 0),
      learningCount: Number(c.learning_count || 0),
      dueCount: Number(c.due_count || 0),
      totalCount: Number(c.total_count || c.cards_count || 0),
      masteredCount: Number(c.mastered_count || 0),
      progressPercent: Number(c.progress_percent || 0),
      nextDueLabel: null,
    }));
  }

  function summaryTotals(session, decks) {
    const stats = session?.stats || {};
    const newCount = decks.reduce((sum, d) => sum + d.newCount, 0) || Number(stats.new_count || 0);
    const learningCount = decks.reduce((sum, d) => sum + d.learningCount, 0) || Number(stats.learning_count || 0);
    const reviewDueCount = decks.reduce((sum, d) => sum + d.dueCount, 0) || Number(stats.review_due_count || 0);
    const totalDue = Number(stats.due_now ?? (newCount + learningCount + reviewDueCount));
    const totalCards = Number(stats.total_cards ?? decks.reduce((s, d) => s + d.totalCount, 0));
    const metrics = activeMetrics(session);
    return {
      totalDue,
      newCount,
      learningCount,
      reviewDueCount,
      totalCards,
      reviewedToday: Number(stats.reviewed_today || 0),
      streakDays: metrics.streakDays,
      learnedCount: Number(stats.learned_count || 0),
      nextDueIn: stats.next_due_in || null,
    };
  }

  function navigateToAnki(subpath = '') {
    const targetHash = subpath ? `#anki/${subpath}` : '#anki';
    if (window.parent !== window && location.pathname.includes('/hustle/')) {
      try {
        window.parent.location.hash = targetHash;
        return;
      } catch {}
    }
    location.hash = targetHash;
  }

  // ==========================================================================
  // 1. Dashboard Summary Card (compact clickable card -> #anki or #anki/study)
  // ==========================================================================
  function drawDashboardWidget(host, session) {
    if (!host || !host.isConnected || !session) return;
    applyTheme(host);
    const cfg = activeConfig(session);
    const decks = courseDecksFromSession(session);
    const totals = summaryTotals(session, decks);
    const retentionPct = Math.round(Number(cfg.targetRetention || 0.9) * 100);

    host.innerHTML = `
      <article class="anki-summary-card" data-anki-summary-card tabindex="0" role="region" aria-label="Інтервальне повторення Anki">
        <div class="anki-summary-main">
          <div class="anki-summary-head">
            <span class="anki-kicker">🧠 Інтервальне повторення · FSRS</span>
            <span class="anki-streak-pill" title="Днів повторення поспіль">🔥 ${totals.streakDays} дн.</span>
          </div>
          <div class="anki-summary-numbers">
            <div class="anki-due-hero">
              <strong>${totals.totalDue}</strong>
              <span>карток на сьогодні</span>
            </div>
            <div class="anki-counter-trio" aria-label="Розподіл карток">
              <span class="anki-pill is-new" title="Нові картки">${totals.newCount} нових</span>
              <span class="anki-pill is-learning" title="У процесі вивчення">${totals.learningCount} вивчається</span>
              <span class="anki-pill is-due" title="Повторення на сьогодні">${totals.reviewDueCount} до повтору</span>
            </div>
          </div>
          <p class="anki-summary-meta">
            Ціль запам’ятовування: <strong>${retentionPct}%</strong> · Бюджет: <strong>${cfg.dailyMinutes} хв/день</strong> (до ${cfg.newCardsLimit} нових) · Повторено сьогодні: <strong>${totals.reviewedToday}</strong>
          </p>
        </div>
        <div class="anki-summary-actions">
          <button type="button" class="primary anki-start-cta" data-anki-start-review>
            ${totals.totalDue > 0 ? 'Почати повторення →' : (totals.totalCards > 0 ? 'Тренуватись поза розкладом →' : 'Відкрити Anki →')}
          </button>
          <div class="anki-summary-secondary">
            <button type="button" class="secondary" data-anki-open-overview>Огляд курсів (${decks.length})</button>
            <button type="button" class="text-button" data-anki-open-settings>⚙ Ціль і час</button>
          </div>
        </div>
      </article>
    `;
  }

  // ==========================================================================
  // 2. Course Overview Page (#anki)
  // ==========================================================================
  function renderCourseOverviewPage(host, session) {
    if (!host || !host.isConnected || !session) return;
    applyTheme(host);
    const cfg = activeConfig(session);
    const decks = courseDecksFromSession(session);
    const totals = summaryTotals(session, decks);
    const theme = getThemePreference();
    const learnedList = session.learned_cards || [];

    host.innerHTML = `
      <div class="anki-page" data-anki-overview-page>
        <div class="anki-page-topbar">
          <div class="anki-page-title-block">
            <a class="text-button anki-back-link" href="#dashboard">← На дашборд</a>
            <h1>Інтервальне повторення Anki</h1>
            <p class="muted">Адаптивний планувальник FSRS · Ціль ${Math.round(cfg.targetRetention * 100)}% · Бюджет ${cfg.dailyMinutes} хв/день (до ${cfg.newCardsLimit} нових/день)</p>
          </div>
          <div class="anki-page-actions">
            <button type="button" class="secondary" data-anki-theme-toggle title="Перемкнути тему">
              ${theme === 'dark' ? '☀️ Світла тема' : '🌙 Темна тема'}
            </button>
            <button type="button" class="secondary" data-anki-open-settings>⚙ Ціль і налаштування</button>
            <button type="button" class="primary" data-anki-start-review>
              ${totals.totalDue > 0 ? `Почати повторення (${totals.totalDue}) →` : 'Повторити все →'}
            </button>
          </div>
        </div>

        <section class="anki-overview-strip" aria-label="Загальна статистика">
          <div class="anki-metric-tile">
            <span>На сьогодні</span>
            <strong>${totals.totalDue}</strong>
            <small>${totals.nextDueIn ? `Наступна через ${esc(totals.nextDueIn)}` : 'Черга актуальна'}</small>
          </div>
          <div class="anki-metric-tile">
            <span>Поточна серія</span>
            <strong>🔥 ${totals.streakDays}</strong>
            <small>днів поспіль</small>
          </div>
          <div class="anki-metric-tile">
            <span>Повторено сьогодні</span>
            <strong>${totals.reviewedToday}</strong>
            <small>Темп ~${Math.round(cfg.avgSecondsPerCard)} с/картка</small>
          </div>
          <div class="anki-metric-tile">
            <span>Всього в базі</span>
            <strong>${totals.totalCards}</strong>
            <small>${totals.learnedCount} вивчених</small>
          </div>
        </section>

        <section class="anki-decks-section" aria-label="Колоди курсів">
          <div class="anki-section-head">
            <h2>Колоди за курсами</h2>
            <div class="anki-legend">
              <span class="anki-pill is-new">Нові</span>
              <span class="anki-pill is-learning">Вивчаються</span>
              <span class="anki-pill is-due">До повтору</span>
            </div>
          </div>
          ${decks.length ? `
            <div class="anki-deck-grid">
              ${decks.map(deck => {
                const dueInDeck = deck.newCount + deck.learningCount + deck.dueCount;
                return `
                  <article class="anki-deck-card" data-anki-deck="${deck.courseId}">
                    <div class="anki-deck-head">
                      <h3>${esc(deck.title)}</h3>
                      <span class="anki-deck-total">${deck.totalCount} карток</span>
                    </div>
                    <div class="anki-counter-trio">
                      <span class="anki-pill is-new" data-anki-new-count>${deck.newCount}</span>
                      <span class="anki-pill is-learning" data-anki-learning-count>${deck.learningCount}</span>
                      <span class="anki-pill is-due" data-anki-due-count>${deck.dueCount}</span>
                    </div>
                    <div class="anki-progress-wrap">
                      <div class="anki-progress-labels">
                        <span>Засвоєння</span>
                        <strong>${deck.progressPercent}% (${deck.masteredCount}/${deck.totalCount})</strong>
                      </div>
                      <div class="anki-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${deck.progressPercent}">
                        <span style="width:${deck.progressPercent}%"></span>
                      </div>
                    </div>
                    <div class="anki-deck-footer">
                      <button type="button" class="primary anki-study-course-btn" data-anki-study-course="${deck.courseId}" data-practice-all="${dueInDeck === 0 && deck.totalCount > 0 ? '1' : '0'}" ${deck.totalCount === 0 ? 'disabled' : ''}>
                        ${dueInDeck > 0 ? `Вчити зараз (${dueInDeck}) →` : (deck.totalCount > 0 ? 'Повторити поза розкладом →' : 'Немає карток')}
                      </button>
                    </div>
                  </article>
                `;
              }).join('')}
            </div>
          ` : `
            <div class="anki-empty-box">
              <div>
                <strong>Поки немає жодної картки для повторення.</strong>
                <p class="muted">Згенеруй картки в будь-якому курсі або створи власну картку нижче.</p>
              </div>
            </div>
          `}
        </section>

        <details class="anki-drawer" data-anki-add-drawer>
          <summary>+ Додати власну картку до колоди</summary>
          <form class="anki-settings-form" data-anki-add-form>
            <label class="anki-field">
              Питання / термін (підтримує Markdown і $LaTeX$)
              <textarea name="front" rows="2" required placeholder="Напр.: Теорема Баєса"></textarea>
            </label>
            <label class="anki-field">
              Відповідь / пояснення
              <textarea name="back" rows="2" required placeholder="$$P(H|E) = \\frac{P(E|H)P(H)}{P(E)}$$"></textarea>
            </label>
            <label class="anki-field">
              Курс
              <select name="course_id">
                <option value="0">Власні визначення</option>
                ${(session.courses || []).filter(c => Number(c.course_id) > 0).map(c => `<option value="${Number(c.course_id)}">${esc(c.title)}</option>`).join('')}
              </select>
            </label>
            <div style="display:flex; align-items:flex-end;">
              <button type="submit" class="primary">+ Додати картку</button>
            </div>
          </form>
        </details>

        <details class="anki-drawer" data-anki-learned-drawer>
          <summary>📖 Вивчені визначення та власні картки (${learnedList.length})</summary>
          ${learnedList.length ? `
            <div class="anki-learned-list">
              ${learnedList.map(c => `
                <div class="anki-learned-row">
                  <div>
                    <strong>${renderInline(c.front)}</strong>
                    <div class="anki-learned-meta">${esc(c.course_title)}${c.topic_title ? ` · ${esc(c.topic_title)}` : ''} · Наступне: ${c.is_due ? 'Зараз' : `через ${esc(c.next_review_in)}`}</div>
                  </div>
                  <button type="button" class="text-button" data-anki-unlearn="${esc(c.card_key)}">Зняти позначку</button>
                </div>
              `).join('')}
            </div>
          ` : '<p class="muted" style="margin:.6rem 0 0;">Поки що немає карток, позначених як вивчені.</p>'}
        </details>
      </div>
    `;
    UI.enhance?.(host);
  }

  // ==========================================================================
  // 3. Distraction-Free Study Interface (#anki/study & #anki/study/:courseId)
  // ==========================================================================
  function initStudySession(session, courseId = null, practiceAll = false) {
    const srs = engine();
    const cfg = activeConfig(session);
    const allCards = allCardsFromSession(session);
    const queue = srs
      ? srs.buildStudyQueue(allCards, cfg, { courseId, practiceAll })
      : (session.queue || []).filter(c => courseId === null || Number(c.course_id) === Number(courseId));

    studyState.courseId = courseId;
    studyState.practiceAll = practiceAll;
    studyState.queue = queue;
    studyState.idx = 0;
    studyState.revealed = false;
    studyState.cardStartedAt = Date.now();
    studyState.sessionStartedAt = Date.now();
    studyState.reviewedInSession = 0;
    studyState.ratingsCount = { again: 0, hard: 0, good: 0, easy: 0 };
    studyState.busy = false;
    studyState.complete = queue.length === 0;
  }

  function stateBadgeHtml(state) {
    if (state === 'new') return '<span class="anki-pill is-new">Нова</span>';
    if (state === 'learning' || state === 'relearning') return '<span class="anki-pill is-learning">Вивчається</span>';
    return '<span class="anki-pill is-due">Повторення</span>';
  }

  function renderStudyView(host, session) {
    if (!host || !host.isConnected || !session) return;
    applyTheme(host);
    const srs = engine();
    const cfg = activeConfig(session);
    const theme = getThemePreference();
    const total = studyState.queue.length;
    const card = studyState.queue[studyState.idx] || null;
    const courseName = studyState.courseId !== null
      ? (session.courses || []).find(c => Number(c.course_id) === Number(studyState.courseId))?.title || 'Колода курсу'
      : 'Усі активні курси';

    if (studyState.complete || !card) {
      const elapsedSec = Math.max(1, Math.round((Date.now() - (studyState.sessionStartedAt || Date.now())) / 1000));
      const mins = Math.floor(elapsedSec / 60);
      const secs = elapsedSec % 60;
      const metrics = activeMetrics(session);
      host.innerHTML = `
        <div class="anki-study-shell" data-anki-study-view>
          <header class="anki-study-topbar">
            <a class="text-button" href="#anki">← До колод</a>
            <span class="anki-study-course">${esc(courseName)}</span>
            <button type="button" class="icon-button" data-anki-theme-toggle aria-label="Перемкнути тему">${theme === 'dark' ? '☀️' : '🌙'}</button>
          </header>
          <section class="anki-study-complete">
            <div class="anki-complete-icon">🎉</div>
            <h2>${studyState.reviewedInSession > 0 ? 'Сесію завершено!' : 'Усе на сьогодні повторено!'}</h2>
            <p class="muted">
              ${studyState.reviewedInSession > 0
                ? `Повторено карток: <strong>${studyState.reviewedInSession}</strong> за ${mins ? `${mins} хв ` : ''}${secs} с · Серія: 🔥 ${metrics.streakDays} дн.`
                : 'У цій колоді зараз немає карток за розкладом FSRS.'}
            </p>
            ${studyState.reviewedInSession > 0 ? `
              <div class="anki-session-breakdown">
                <span class="anki-pill is-learning">Знову: ${studyState.ratingsCount.again}</span>
                <span class="anki-pill is-hard">Важко: ${studyState.ratingsCount.hard}</span>
                <span class="anki-pill is-good">Добре: ${studyState.ratingsCount.good}</span>
                <span class="anki-pill is-due">Легко: ${studyState.ratingsCount.easy}</span>
              </div>
            ` : ''}
            <div class="anki-complete-actions">
              <a class="primary" href="#anki">До огляду курсів</a>
              <button type="button" class="secondary" data-anki-cram-course="${studyState.courseId !== null ? studyState.courseId : ''}">Повторити поза розкладом</button>
            </div>
          </section>
        </div>
      `;
      return;
    }

    const preview = srs ? srs.getSchedulingPreview(card, cfg) : null;
    const progressPct = total > 0 ? Math.round(((studyState.idx + (studyState.revealed ? 0.5 : 0)) / total) * 100) : 0;

    host.innerHTML = `
      <div class="anki-study-shell" data-anki-study-view>
        <header class="anki-study-topbar">
          <a class="text-button" href="#anki" title="Вийти (Esc)">← Вийти</a>
          <div class="anki-study-progress-wrap">
            <div class="anki-study-progress-meta">
              <span>${esc(card.courseTitle || courseName)}${card.topicTitle ? ` · ${esc(card.topicTitle)}` : ''}</span>
              <strong>${studyState.idx + 1} / ${total}</strong>
            </div>
            <div class="anki-progress-bar" aria-label="Прогрес сесії">
              <span style="width:${progressPct}%"></span>
            </div>
          </div>
          <div class="anki-study-tools">
            ${stateBadgeHtml(card.state)}
            <button type="button" class="icon-button" data-anki-theme-toggle aria-label="Перемкнути тему" title="Тема">${theme === 'dark' ? '☀️' : '🌙'}</button>
            <button type="button" class="icon-button" data-anki-open-settings aria-label="Налаштування FSRS" title="Ціль і FSRS">${icon('settings')}</button>
          </div>
        </header>

        <div class="anki-flip-stage">
          <div class="anki-flip-card ${studyState.revealed ? 'is-flipped' : ''}" data-anki-flip-card>
            <section class="anki-card-face anki-card-front" aria-hidden="${studyState.revealed ? 'true' : 'false'}">
              <div class="anki-face-header">
                <span class="anki-face-label">Питання</span>
                <button type="button"
                        class="anki-learn-toggle ${card.isLearned ? 'is-learned' : ''}"
                        data-anki-toggle-learned="${esc(card.id)}"
                        data-learned="${card.isLearned ? '1' : '0'}">
                  ${card.isLearned ? '✓ Вивчена' : '○ Позначити як вивчену'}
                </button>
              </div>
              <div class="anki-face-content reader-prose">${renderRich(card.front)}</div>
              <div class="anki-face-hint">Натисни <kbd>Space</kbd> або кнопку нижче, щоб відкрити відповідь</div>
            </section>

            <section class="anki-card-face anki-card-back" aria-hidden="${studyState.revealed ? 'false' : 'true'}">
              <div class="anki-face-header">
                <span class="anki-face-label">Відповідь</span>
                <button type="button"
                        class="anki-learn-toggle ${card.isLearned ? 'is-learned' : ''}"
                        data-anki-toggle-learned="${esc(card.id)}"
                        data-learned="${card.isLearned ? '1' : '0'}">
                  ${card.isLearned ? '✓ Вивчена' : '○ Позначити як вивчену'}
                </button>
              </div>
              <div class="anki-back-prompt">${renderInline(card.front)}</div>
              <div class="anki-face-content reader-prose">${renderRich(card.back)}</div>
              ${card.sourceCitation ? `<div class="anki-citation">Джерело: ${esc(card.sourceCitation)}</div>` : ''}
            </section>
          </div>
        </div>

        <footer class="anki-study-dock">
          ${studyState.revealed ? `
            <div class="anki-rating-grid anki-study-ratings" role="group" aria-label="Оцінка пам’яті (клавіші 1–4)">
              ${[
                ['again', 'Знову', '1', 'again'],
                ['hard', 'Важко', '2', 'hard'],
                ['good', 'Добре', '3', 'good'],
                ['easy', 'Легко', '4', 'easy'],
              ].map(([key, label, shortcut, cls]) => {
                const opt = preview?.[key];
                const intervalText = opt?.intervalLabel || '';
                return `
                  <button type="button" class="anki-rate-btn ${cls}" data-anki-study-rate="${key}" ${studyState.busy ? 'disabled' : ''}>
                    <span class="anki-rate-int">${esc(intervalText)}</span>
                    <span class="anki-rate-label">${label}</span>
                    <kbd>${shortcut}</kbd>
                  </button>
                `;
              }).join('')}
            </div>
          ` : `
            <button type="button" class="primary anki-reveal-btn" data-anki-study-reveal>
              Показати відповідь <kbd>Space</kbd>
            </button>
          `}
        </footer>
      </div>
    `;
    UI.enhance?.(host);
  }

  async function submitStudyRating(rating) {
    if (studyState.busy || !studyState.revealed) return;
    const card = studyState.queue[studyState.idx];
    if (!card) return;
    const srs = engine();
    const cfg = activeConfig(lastSession);
    const durationMs = Math.max(1000, Date.now() - (studyState.cardStartedAt || Date.now()));

    studyState.busy = true;
    activePageHost?.querySelectorAll('[data-anki-study-rate]').forEach(btn => { btn.disabled = true; });

    try {
      let payload = { card_key: card.id, rating, review_duration_ms: durationMs };
      if (srs) {
        const result = srs.reviewCard(card, rating, cfg, new Date());
        payload = srs.toBackendReviewPayload(result, durationMs);
        srs.recordLocalReviewMetric(ownerId(), durationMs, new Date());
      }
      const res = await apiReq('/api/workspace/anki/cards/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastSession = res.session;
      studyState.reviewedInSession += 1;
      studyState.ratingsCount[rating] = (studyState.ratingsCount[rating] || 0) + 1;

      if (rating === 'again' && studyState.queue.length > 1) {
        // Re-queue failed card within the same active study session (classic Anki behavior)
        const updatedCard = srs
          ? srs.fromBackendCard((res.session?.cards || []).find(c => c.card_key === card.id) || card)
          : card;
        studyState.queue.splice(studyState.idx, 1);
        const reinsertAt = Math.min(studyState.queue.length, studyState.idx + 2);
        studyState.queue.splice(reinsertAt, 0, updatedCard);
      } else {
        studyState.idx += 1;
      }

      if (studyState.idx >= studyState.queue.length) {
        studyState.complete = true;
      }
      studyState.revealed = false;
      studyState.cardStartedAt = Date.now();
      studyState.busy = false;
      renderStudyView(activePageHost, lastSession);
      if (activeDashboardHost?.isConnected) drawDashboardWidget(activeDashboardHost, lastSession);
    } catch (err) {
      studyState.busy = false;
      UI.toast?.(err.message);
      renderStudyView(activePageHost, lastSession);
    }
  }

  // ==========================================================================
  // 4. Adaptive Goal & Time Calibration Modal + Advanced FSRS Settings Drawer
  // ==========================================================================
  function openSettingsModal() {
    const dialog = document.querySelector('#study-dialog');
    const body = document.querySelector('#dialog-body');
    if (!dialog || !body) return;

    const srs = engine();
    const session = lastSession || { settings: {}, courses: [], stats: {} };
    const cfg = activeConfig(session);
    const metrics = activeMetrics(session);
    const retentionPct = Math.round(cfg.targetRetention * 100);
    const cal = srs
      ? srs.calibrateGoalAndTime({
          targetRetention: cfg.targetRetention,
          dailyMinutes: cfg.dailyMinutes,
          avgSecondsPerCard: cfg.avgSecondsPerCard,
          dueReviewCount: Number(session.stats?.review_due_count || 0),
        })
      : { newCardsLimit: cfg.newCardsLimit, totalDailyCapacity: 60, explanation: '' };
    const courses = (session.courses || []).filter(c => Number(c.course_id) > 0);
    const selectedCourses = new Set((cfg.courseIds || []).map(Number));

    body.innerHTML = `
      <h2 id="dialog-title">Налаштування мети та FSRS</h2>
      <form class="anki-modal-form" data-anki-calibration-form>
        <section class="anki-cal-section">
          <div class="anki-cal-head">
            <label for="anki-retention-range"><strong>1. Ціль запам’ятовування (Retention Goal)</strong></label>
            <span class="anki-cal-badge" data-cal-retention-label>${retentionPct}%</span>
          </div>
          <input id="anki-retention-range" type="range" name="target_retention_pct" min="80" max="98" step="1" value="${retentionPct}">
          <div class="anki-preset-row">
            ${[85, 90, 95].map(p => `<button type="button" class="anki-preset-btn ${retentionPct === p ? 'is-active' : ''}" data-preset-retention="${p}">${p}%</button>`).join('')}
          </div>
          <small class="muted">Прямо задає FSRS <code>request_retention</code>. Вищий відсоток — частіше повторення перед іспитом.</small>
        </section>

        <section class="anki-cal-section">
          <div class="anki-cal-head">
            <label for="anki-daily-minutes"><strong>2. Щоденний бюджет часу (хв/день)</strong></label>
            <span class="anki-cal-badge" data-cal-minutes-label>${cfg.dailyMinutes} хв</span>
          </div>
          <div class="anki-preset-row">
            ${[10, 20, 30, 45, 60].map(m => `<button type="button" class="anki-preset-btn ${cfg.dailyMinutes === m ? 'is-active' : ''}" data-preset-minutes="${m}">${m} хв</button>`).join('')}
            <input id="anki-daily-minutes" type="number" name="daily_minutes" min="5" max="240" value="${cfg.dailyMinutes}" style="width:5.5rem;">
          </div>
          <div class="anki-cal-preview" data-cal-preview>
            ${esc(cal.explanation)}
          </div>
        </section>

        <details class="anki-drawer anki-advanced-drawer">
          <summary>⚙ Розширені параметри Anki / FSRS (кроки, ліміти, ваги)</summary>
          <div class="anki-settings-form">
            <label class="anki-field">
              Ліміт нових карток / день
              <input type="number" name="new_cards_limit" min="0" max="100" value="${cfg.newCardsLimit}">
            </label>
            <label class="anki-field">
              Макс. повторень / день
              <input type="number" name="daily_limit" min="1" max="500" value="${cfg.dailyReviewLimit}">
            </label>
            <label class="anki-field">
              Макс. інтервал (днів)
              <input type="number" name="maximum_interval" min="1" max="36500" value="${cfg.maximumInterval}">
            </label>
            <label class="anki-field">
              Середній час картки (сек)
              <input type="number" step="0.5" min="5" max="120" name="avg_seconds_per_card" value="${metrics.avgSecondsPerCard || cfg.avgSecondsPerCard}">
            </label>
            <label class="anki-field">
              Learning steps (хв, через кому)
              <input type="text" name="learning_steps" value="${esc((cfg.learningSteps || [1, 10]).join(', '))}">
            </label>
            <label class="anki-field">
              Relearning steps (хв, через кому)
              <input type="text" name="relearning_steps" value="${esc((cfg.relearningSteps || [10]).join(', '))}">
            </label>
            <label class="anki-field" style="grid-column:1 / -1;">
              FSRS ваги (w)
              <input type="text" name="fsrs_weights" value="${esc((cfg.weights || []).join(', '))}">
            </label>
            <div style="grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:.8rem; align-items:center;">
              <label class="anki-check-row">
                <input type="checkbox" name="include_learned" ${cfg.includeLearned !== false ? 'checked' : ''}>
                Включати вивчені дефініції
              </label>
              <label class="anki-check-row">
                <input type="checkbox" name="include_new" ${cfg.includeNew !== false ? 'checked' : ''}>
                Включати нові картки
              </label>
              <button type="button" class="text-button" data-reset-fsrs-weights>Скинути FSRS за замовчуванням</button>
            </div>
            ${courses.length ? `
              <div class="anki-courses-box">
                <span style="width:100%; font-size:.77rem; font-weight:700;">Фільтр курсів (порожньо = усі):</span>
                ${courses.map(c => `
                  <label class="anki-check-row">
                    <input type="checkbox" name="course_ids" value="${Number(c.course_id)}" ${selectedCourses.has(Number(c.course_id)) ? 'checked' : ''}>
                    ${esc(c.title)}
                  </label>
                `).join('')}
              </div>
            ` : ''}
          </div>
        </details>

        <div class="anki-modal-footer">
          <button type="button" class="secondary" data-close-anki-modal>Скасувати</button>
          <button type="submit" class="primary">Зберегти та відкалібрувати</button>
        </div>
        <p id="dialog-error" class="field-error" role="alert" hidden></p>
      </form>
    `;

    const form = body.querySelector('[data-anki-calibration-form]');
    let manualNewOverride = false;

    function recalibrateLive() {
      const retPct = Number(form.elements.target_retention_pct.value || 90);
      const mins = Number(form.elements.daily_minutes.value || 20);
      const secPer = Number(form.elements.avg_seconds_per_card.value || 18);
      form.querySelector('[data-cal-retention-label]').textContent = `${retPct}%`;
      form.querySelector('[data-cal-minutes-label]').textContent = `${mins} хв`;
      form.querySelectorAll('[data-preset-retention]').forEach(b => b.classList.toggle('is-active', Number(b.dataset.presetRetention) === retPct));
      form.querySelectorAll('[data-preset-minutes]').forEach(b => b.classList.toggle('is-active', Number(b.dataset.presetMinutes) === mins));

      if (srs) {
        const nextCal = srs.calibrateGoalAndTime({
          targetRetention: retPct / 100,
          dailyMinutes: mins,
          avgSecondsPerCard: secPer,
          dueReviewCount: Number(session.stats?.review_due_count || 0),
        });
        if (!manualNewOverride) {
          form.elements.new_cards_limit.value = String(nextCal.newCardsLimit);
        }
        form.querySelector('[data-cal-preview]').textContent = nextCal.explanation;
      }
    }

    form.addEventListener('input', (e) => {
      if (e.target === form.elements.new_cards_limit) {
        manualNewOverride = true;
      } else {
        recalibrateLive();
      }
    });

    form.addEventListener('click', (e) => {
      const retBtn = e.target.closest('[data-preset-retention]');
      if (retBtn) {
        form.elements.target_retention_pct.value = retBtn.dataset.presetRetention;
        manualNewOverride = false;
        recalibrateLive();
        return;
      }
      const minBtn = e.target.closest('[data-preset-minutes]');
      if (minBtn) {
        form.elements.daily_minutes.value = minBtn.dataset.presetMinutes;
        manualNewOverride = false;
        recalibrateLive();
        return;
      }
      if (e.target.closest('[data-reset-fsrs-weights]')) {
        if (srs) form.elements.fsrs_weights.value = srs.getDefaultWeights().join(', ');
        return;
      }
      if (e.target.closest('[data-close-anki-modal]')) {
        dialog.close();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const parseInts = (str, fallback) => {
        const list = String(str || '').split(/[,\s]+/).map(s => Math.round(Number(s.trim()))).filter(n => Number.isFinite(n) && n > 0);
        return list.length ? list.slice(0, 5) : fallback;
      };
      const parseFloats = (str) => String(str || '').split(/[,\s]+/).map(s => Number(s.trim())).filter(n => Number.isFinite(n));

      const rawRet = Number(fd.get('target_retention_pct') || 90) / 100;
      const dailyMinutes = Number(fd.get('daily_minutes') || 20);
      const avgSec = Number(fd.get('avg_seconds_per_card') || 18);
      const newLimit = Number(fd.get('new_cards_limit') ?? 15);
      const dailyLimit = Number(fd.get('daily_limit') || 100);
      const maxInt = Number(fd.get('maximum_interval') || 365);
      const learningSteps = parseInts(fd.get('learning_steps'), [1, 10]);
      const relearningSteps = parseInts(fd.get('relearning_steps'), [10]);
      const weights = parseFloats(fd.get('fsrs_weights'));
      const courseIds = fd.getAll('course_ids').map(Number).filter(n => n > 0);

      const payload = {
        target_retention: rawRet,
        daily_minutes: dailyMinutes,
        avg_seconds_per_card: avgSec,
        new_cards_limit: newLimit,
        daily_limit: dailyLimit,
        maximum_interval: maxInt,
        learning_steps: learningSteps,
        relearning_steps: relearningSteps,
        fsrs_weights: weights,
        include_learned: form.elements.include_learned?.checked ?? true,
        include_new: form.elements.include_new?.checked ?? true,
        course_ids: courseIds,
      };

      try {
        const updatedSession = await apiReq('/api/workspace/anki/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        lastSession = updatedSession;
        srs?.saveLocalConfig?.(ownerId(), {
          targetRetention: rawRet,
          dailyMinutes,
          avgSecondsPerCard: avgSec,
          newCardsLimit: newLimit,
          dailyReviewLimit: dailyLimit,
          maximumInterval: maxInt,
          learningSteps,
          relearningSteps,
          weights,
          includeLearned: payload.include_learned,
          includeNew: payload.include_new,
          courseIds,
        });
        dialog.close();
        UI.toast?.('Ціль навчання та параметри FSRS оновлено.');
        if (activeDashboardHost?.isConnected) drawDashboardWidget(activeDashboardHost, lastSession);
        if (activePageHost?.isConnected) {
          if (activePageHost.querySelector('[data-anki-study-view]')) {
            initStudySession(lastSession, studyState.courseId, studyState.practiceAll);
            renderStudyView(activePageHost, lastSession);
          } else if (activePageHost.querySelector('[data-anki-overview-page]')) {
            renderCourseOverviewPage(activePageHost, lastSession);
          }
        }
      } catch (err) {
        const errEl = body.querySelector('#dialog-error');
        if (errEl) {
          errEl.textContent = err.message;
          errEl.hidden = false;
        }
      }
    });

    if (!dialog.open) dialog.showModal();
  }

  // ==========================================================================
  // 5. Event Listeners, Keyboard Navigation & Public Mount API
  // ==========================================================================
  function bindSharedHandlers(host) {
    if (!host || host.dataset.ankiBound) return;
    host.dataset.ankiBound = '1';

    host.addEventListener('click', async (event) => {
      if (event.target.closest('[data-anki-theme-toggle]')) {
        const next = getThemePreference() === 'dark' ? 'light' : 'dark';
        applyTheme(host, next);
        if (activeDashboardHost) applyTheme(activeDashboardHost, next);
        if (activePageHost?.querySelector('[data-anki-study-view]')) renderStudyView(activePageHost, lastSession);
        else if (activePageHost?.querySelector('[data-anki-overview-page]')) renderCourseOverviewPage(activePageHost, lastSession);
        return;
      }

      if (event.target.closest('[data-anki-open-settings]')) {
        openSettingsModal();
        return;
      }

      if (event.target.closest('[data-anki-open-overview]')) {
        navigateToAnki('');
        return;
      }

      if (event.target.closest('[data-anki-start-review]')) {
        navigateToAnki('study');
        return;
      }

      const studyCourseBtn = event.target.closest('[data-anki-study-course]');
      if (studyCourseBtn) {
        const cid = studyCourseBtn.dataset.ankiStudyCourse;
        const cram = studyCourseBtn.dataset.practiceAll === '1';
        navigateToAnki(`study/${cid}${cram ? '?all=1' : ''}`);
        return;
      }

      const cramBtn = event.target.closest('[data-anki-cram-course]');
      if (cramBtn) {
        const cid = cramBtn.dataset.ankiCramCourse ? Number(cramBtn.dataset.ankiCramCourse) : null;
        initStudySession(lastSession, cid, true);
        renderStudyView(activePageHost, lastSession);
        return;
      }

      if (event.target.closest('[data-anki-study-reveal]')) {
        studyState.revealed = true;
        renderStudyView(activePageHost, lastSession);
        return;
      }

      const rateBtn = event.target.closest('[data-anki-study-rate]');
      if (rateBtn) {
        await submitStudyRating(rateBtn.dataset.ankiStudyRate);
        return;
      }

      const toggleBtn = event.target.closest('[data-anki-toggle-learned]');
      if (toggleBtn) {
        const key = toggleBtn.dataset.ankiToggleLearned;
        const nextLearned = toggleBtn.dataset.learned !== '1';
        toggleBtn.disabled = true;
        try {
          const res = await apiReq('/api/workspace/anki/cards/learned', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card_key: key, learned: nextLearned }),
          });
          lastSession = res.session;
          if (studyState.queue[studyState.idx]?.id === key) {
            studyState.queue[studyState.idx].isLearned = nextLearned;
          }
          if (activePageHost?.querySelector('[data-anki-study-view]')) renderStudyView(activePageHost, lastSession);
          else if (activePageHost?.querySelector('[data-anki-overview-page]')) renderCourseOverviewPage(activePageHost, lastSession);
          if (activeDashboardHost?.isConnected) drawDashboardWidget(activeDashboardHost, lastSession);
          UI.toast?.(nextLearned ? 'Позначено як вивчену для Anki.' : 'Позначку вивченої знято.');
        } catch (err) {
          UI.toast?.(err.message);
          toggleBtn.disabled = false;
        }
        return;
      }

      const unlearnBtn = event.target.closest('[data-anki-unlearn]');
      if (unlearnBtn) {
        unlearnBtn.disabled = true;
        try {
          const res = await apiReq('/api/workspace/anki/cards/learned', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card_key: unlearnBtn.dataset.ankiUnlearn, learned: false }),
          });
          lastSession = res.session;
          if (activePageHost?.querySelector('[data-anki-overview-page]')) renderCourseOverviewPage(activePageHost, lastSession);
          if (activeDashboardHost?.isConnected) drawDashboardWidget(activeDashboardHost, lastSession);
        } catch (err) {
          UI.toast?.(err.message);
          unlearnBtn.disabled = false;
        }
        return;
      }

      const summaryCard = event.target.closest('[data-anki-summary-card]');
      if (summaryCard && !event.target.closest('button,a,input,select,label')) {
        navigateToAnki('');
      }
    });

    host.addEventListener('submit', async (event) => {
      const addForm = event.target.closest('[data-anki-add-form]');
      if (!addForm) return;
      event.preventDefault();
      const front = addForm.elements.front?.value?.trim() || '';
      const back = addForm.elements.back?.value?.trim() || '';
      const courseId = Number(addForm.elements.course_id?.value || 0);
      if (!front || !back) return;
      try {
        const res = await apiReq('/api/workspace/anki/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ front, back, course_id: courseId, is_learned: false }),
        });
        lastSession = res.session;
        if (activePageHost?.querySelector('[data-anki-overview-page]')) renderCourseOverviewPage(activePageHost, lastSession);
        if (activeDashboardHost?.isConnected) drawDashboardWidget(activeDashboardHost, lastSession);
        UI.toast?.('Картку додано до колоди Anki.');
      } catch (err) {
        UI.toast?.(err.message);
      }
    });
  }

  // Global keyboard shortcuts inside the distraction-free study view
  document.addEventListener('keydown', (event) => {
    if (!activePageHost?.isConnected) return;
    const studyEl = activePageHost.querySelector('[data-anki-study-view]');
    if (!studyEl || document.querySelector('dialog[open]')) return;
    const tag = (event.target?.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || event.target?.isContentEditable) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      navigateToAnki('');
      return;
    }

    if (studyState.complete || !studyState.queue[studyState.idx]) return;

    if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault();
      if (!studyState.revealed) {
        studyState.revealed = true;
        renderStudyView(activePageHost, lastSession);
      }
      return;
    }

    if (studyState.revealed && ['1', '2', '3', '4'].includes(event.key)) {
      event.preventDefault();
      const ratingMap = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' };
      submitStudyRating(ratingMap[event.key]);
    }
  });

  async function refreshSession(courseId = null, practiceAll = false) {
    const qs = new URLSearchParams();
    qs.set('practice_all', practiceAll ? 'true' : 'false');
    if (courseId !== null && !Number.isNaN(Number(courseId))) {
      qs.set('course_id', String(courseId));
    }
    const data = await apiReq(`/api/workspace/anki/session?${qs.toString()}`);
    lastSession = data;
    return data;
  }

  async function mount(root, account) {
    if (account) activeAccount = account;
    const host = root?.querySelector('[data-today-anki]');
    if (!host) return;
    activeDashboardHost = host;
    bindSharedHandlers(host);

    if (lastSession) {
      drawDashboardWidget(host, lastSession);
    } else {
      host.innerHTML = `<div class="anki-summary-card"><p class="muted" role="status" style="margin:0;">Завантажуємо інтервальне повторення Anki…</p></div>`;
    }

    try {
      const data = await refreshSession(null, false);
      if (host.isConnected) drawDashboardWidget(host, data);
    } catch (err) {
      if (host.isConnected) {
        host.innerHTML = `<div class="anki-summary-card"><p role="alert" class="field-error" style="margin:0;">${esc(err.message)}</p></div>`;
      }
    }
  }

  async function mountPage(main, account) {
    if (account) activeAccount = account;
    activePageHost = main;
    bindSharedHandlers(main);

    const [path, query = ''] = location.hash.slice(1).split('?');
    const parts = path.split('/');
    const params = new URLSearchParams(query);
    const isStudy = parts[1] === 'study';
    const courseId = isStudy && parts[2] !== undefined && parts[2] !== '' && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null;
    const practiceAll = params.get('all') === '1';

    main.innerHTML = `<div class="anki-page"><p class="muted" role="status">Завантажуємо колоди Anki…</p></div>`;
    try {
      const session = await refreshSession(null, practiceAll);
      if (!main.isConnected) return;
      if (isStudy) {
        initStudySession(session, courseId, practiceAll);
        renderStudyView(main, session);
      } else {
        renderCourseOverviewPage(main, session);
      }
    } catch (err) {
      if (main.isConnected) {
        main.innerHTML = `<div class="anki-page"><p role="alert" class="field-error">${esc(err.message)}</p></div>`;
      }
    }
  }

  async function toggleLearnedFromCourse(payload) {
    const res = await apiReq('/api/workspace/anki/cards/learned', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res?.session) {
      lastSession = res.session;
      if (activeDashboardHost?.isConnected) drawDashboardWidget(activeDashboardHost, res.session);
    }
    return res;
  }

  function isLearnedSync(front, courseId, topicIndex) {
    if (!lastSession?.learned_cards?.length) return false;
    const norm = String(front || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return lastSession.learned_cards.some(
      c => String(c.course_id) === String(courseId)
        && String(c.topic_index) === String(topicIndex)
        && String(c.front || '').trim().toLowerCase().replace(/\s+/g, ' ') === norm
    );
  }

  window.HustleAnki = {
    mount,
    mountPage,
    openSettingsModal,
    toggleLearnedFromCourse,
    isLearnedSync,
  };
})();
