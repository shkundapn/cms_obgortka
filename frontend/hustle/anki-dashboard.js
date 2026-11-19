/* Comprehensive Anki Spaced Repetition Module (powered exclusively through HustleSRSEngine) */
(() => {
  const { escape: esc, icon } = UI;
  const cardsLabel = count => UI.countLabel(count, 'картка', 'картки', 'карток');

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

  function courseDecksFromSession(session, cards) {
    const srs = engine();
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

  function studyQueue(session, courseId, practiceAll, cards = allCardsFromSession(session)) {
    const srs = engine();
    return srs
      ? srs.buildStudyQueue(cards, activeConfig(session), { courseId, practiceAll })
      : (session.queue || []).filter(c => courseId === null || Number(c.course_id) === Number(courseId));
  }

  function reviewOffer(session, courseId = null, cards = allCardsFromSession(session)) {
    const queue = studyQueue(session, courseId, false, cards);
    const count = queue.length;
    const practiceAll = !count && studyQueue(session, courseId, true, cards).length > 0;
    const path = courseId === null ? '#anki/study' : `#anki/study/${courseId}`;
    return {
      count,
      queue,
      href: count ? path : practiceAll ? `${path}?all=1` : '',
      label: count ? 'Повторити' : 'Повторити поза розкладом',
    };
  }

  function decksWithReview(session, cards) {
    const cardsByCourse = new Map();
    for (const card of cards) {
      const id = Number(card.courseId ?? card.course_id);
      if (!cardsByCourse.has(id)) cardsByCourse.set(id, []);
      cardsByCourse.get(id).push(card);
    }
    return courseDecksFromSession(session, cards).map(deck => ({
      ...deck,
      review: reviewOffer(session, deck.courseId, cardsByCourse.get(deck.courseId) || []),
    }));
  }

  function countsInQueue(queue) {
    const counts = { newCount: 0, learningCount: 0, dueCount: 0 };
    for (const card of queue) {
      const state = card.state ?? card.card_state;
      if (state === 'new') counts.newCount += 1;
      else if (state === 'learning' || state === 'relearning') counts.learningCount += 1;
      else counts.dueCount += 1;
    }
    return counts;
  }

  function renderDeckCounts({ newCount, learningCount, dueCount }) {
    return `
      <dl class="anki-deck-counts">
        <div><dt>Нові</dt><dd data-anki-new-count>${newCount}</dd></div>
        <div><dt>У вивченні</dt><dd data-anki-learning-count>${learningCount}</dd></div>
        <div><dt>До повторення</dt><dd data-anki-due-count>${dueCount}</dd></div>
      </dl>`;
  }

  function reviewStatus(session, review) {
    if (review.count) return `${cardsLabel(review.count)} на сьогодні`;
    return Number(session.stats?.total_cards ?? allCardsFromSession(session).length)
      ? 'Карток за розкладом немає'
      : 'Поки немає карток';
  }

  function settingsButton(compact = false) {
    return `<button type="button" class="${compact ? 'icon-button anki-settings-button' : 'secondary'}"
      data-anki-open-settings aria-label="Налаштування Anki" ${compact ? 'title="Налаштування Anki"' : ''}>
      ${icon('settings')}${compact ? '' : ' Налаштування'}
    </button>`;
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
  // Dashboard panel with the daily queue and course-level study actions.
  // ==========================================================================
  function renderDashboardDeck(deck) {
    const title = esc(UI.courseName(deck.title));
    const { review } = deck;
    const action = review.count ? 'Повторити' : 'Поза розкладом';

    return `
      <article class="anki-dashboard-deck" data-anki-dashboard-deck="${deck.courseId}">
        <div class="anki-deck-identity">
          <div class="anki-deck-title">
            <h4>${title}</h4>
            <span>${cardsLabel(deck.totalCount)} у колоді</span>
          </div>
        </div>
        ${renderDeckCounts(countsInQueue(review.queue))}
        ${review.href ? `<a class="anki-text-action anki-dashboard-deck-action" href="${review.href}"
          data-anki-study-course="${deck.courseId}" aria-label="${action} · ${title}">
          ${action} ${icon('arrow')}
        </a>` : ''}
      </article>`;
  }

  function drawDashboardWidget(host, session) {
    if (!host || !host.isConnected || !session) return;
    const cards = allCardsFromSession(session);
    const review = reviewOffer(session, null, cards);
    const decks = decksWithReview(session, cards).filter(deck => deck.totalCount > 0);
    const reviewedToday = Number(session.stats?.reviewed_today || 0);

    host.innerHTML = `
      <article class="anki-summary-card" data-anki-summary-card>
        <header class="anki-dashboard-head">
          <div class="anki-summary-main">
            <span class="anki-symbol">${icon('cards')}</span>
            <h2>Картки Anki</h2>
          </div>
          ${settingsButton(true)}
        </header>
        <section class="anki-dashboard-today" aria-label="Черга на сьогодні">
          <div class="anki-dashboard-today-copy">
            <h3>На сьогодні</h3>
            <p>${review.count ? cardsLabel(review.count) : reviewStatus(session, review)}</p>
            ${reviewedToday ? `<small>Вже повторено ${reviewedToday}</small>` : ''}
          </div>
          ${review.href ? `<a class="primary" href="${review.href}" data-anki-start-review>
            ${review.count ? 'Почати повторення' : review.label} ${icon('arrow')}
          </a>` : ''}
        </section>
        ${decks.length ? `
          <section class="anki-dashboard-courses" aria-label="Картки за предметами">
            <header class="anki-dashboard-subhead">
              <h3>За предметами</h3>
              <a class="anki-text-action" href="#anki" data-anki-open-overview>Усі колоди ${icon('arrow')}</a>
            </header>
            <div class="anki-dashboard-decks">${decks.map(renderDashboardDeck).join('')}</div>
          </section>` : `
          <a class="anki-text-action anki-dashboard-empty-link" href="#anki" data-anki-open-overview>Усі колоди ${icon('arrow')}</a>`}
      </article>
    `;
    window.HustleRewards?.setAnkiQueue(review.queue, reviewedToday);
  }

  // ==========================================================================
  // 2. Course Overview Page (#anki)
  // ==========================================================================
  function renderDeck(deck) {
    const { review } = deck;
    return `
      <article class="anki-deck-card" data-anki-deck="${deck.courseId}">
        <div class="anki-deck-identity">
          <span class="anki-symbol anki-symbol--small">${icon('cards')}</span>
          <div class="anki-deck-title">
            <h3>${esc(UI.courseName(deck.title))}</h3>
            <span>${cardsLabel(deck.totalCount)}</span>
          </div>
        </div>
        ${deck.totalCount ? `
          ${renderDeckCounts(deck)}
          <div class="anki-deck-progress">
            <span>Опрацьовано</span>
            <strong>${deck.masteredCount} / ${deck.totalCount}</strong>
            <progress class="anki-progress-bar" aria-label="Прогрес колоди" max="100" value="${deck.progressPercent}"></progress>
          </div>` : ''}
        ${review.href ? `<a class="secondary anki-deck-action" href="${review.href}" data-anki-study-course="${deck.courseId}">
          ${review.count ? 'Повторити' : 'Поза розкладом'} ${icon('arrow')}
        </a>` : ''}
      </article>`;
  }

  function renderCourseOverviewPage(host, session) {
    if (!host || !host.isConnected || !session) return;
    const cards = allCardsFromSession(session);
    const decks = decksWithReview(session, cards);
    const review = reviewOffer(session, null, cards);
    const learnedList = session.learned_cards || [];
    const reviewedToday = Number(session.stats?.reviewed_today || 0);
    const nextDue = !review.count && session.stats?.next_due_in;
    const pastForm = host.querySelector('[data-anki-add-form]');
    const draft = pastForm && new FormData(pastForm);
    const addOpen = host.querySelector('[data-anki-add-drawer]')?.open;
    const learnedOpen = host.querySelector('[data-anki-learned-drawer]')?.open;
    const rewards = (window.frameElement ? window.parent : window).HustleRewards;
    const sticker = rewards?.marker('card-trick');
    const deckHeading = '<h2 id="anki-decks-title">Колоди за курсами</h2>';

    host.innerHTML = `
      <div class="anki-page" data-anki-overview-page>
        <a class="anki-text-action anki-back-link" href="#dashboard">${icon('arrow-left')} Мій огляд</a>
        <header class="anki-page-topbar">
          <h1 tabindex="-1">Картки Anki</h1>
          ${settingsButton()}
        </header>

        <section class="anki-today" aria-labelledby="anki-today-title">
          <span class="anki-symbol">${icon('cards')}</span>
          <div class="anki-today-copy">
            <h2 id="anki-today-title">${reviewStatus(session, review)}</h2>
            ${nextDue ? `<p>Наступна картка через ${esc(nextDue)}</p>` :
              reviewedToday ? `<p>Повторено сьогодні · ${cardsLabel(reviewedToday)}</p>` : ''}
          </div>
          ${review.href ? `<a class="primary" href="${review.href}" data-anki-start-review>${review.label} ${icon('arrow')}</a>` : ''}
        </section>

        <section class="anki-decks-section" aria-labelledby="anki-decks-title">
          ${sticker ? `<div class="reward-scene-heading reward-decks-heading">${deckHeading}${sticker}</div>` : deckHeading}
          ${decks.length ? `<div class="anki-deck-grid">${decks.map(renderDeck).join('')}</div>` :
            '<p class="anki-empty-box">Тут з’являться картки з курсів і власні картки.</p>'}
        </section>

        <div class="anki-drawers">
          <details class="anki-drawer" data-anki-add-drawer ${addOpen ? 'open' : ''}>
            <summary>${icon('plus')} Додати картку ${icon('chevron-down')}</summary>
            <form class="anki-settings-form anki-add-form" data-anki-add-form>
              <label class="anki-field">
                Питання або термін
                <textarea name="front" rows="3" required></textarea>
              </label>
              <label class="anki-field">
                Відповідь
                <textarea name="back" rows="3" required></textarea>
              </label>
              <label class="anki-field">
                Колода
                <select name="course_id">
                  <option value="0">Власні визначення</option>
                  ${(session.courses || []).filter(c => Number(c.course_id) > 0).map(c =>
                    `<option value="${Number(c.course_id)}">${esc(UI.courseName(c.title))}</option>`).join('')}
                </select>
              </label>
              <div class="anki-form-actions">
                <button type="submit" class="primary">${icon('plus')} Додати картку</button>
              </div>
            </form>
          </details>

          <details class="anki-drawer" data-anki-learned-drawer ${learnedOpen ? 'open' : ''}>
            <summary>${icon('bookmark')} <span>Позначені як вивчені <span class="anki-drawer-count">${learnedList.length}</span></span> ${icon('chevron-down')}</summary>
            ${learnedList.length ? `
              <div class="anki-learned-list">
                ${learnedList.map(c => `
                  <div class="anki-learned-row">
                    <div>
                      <strong>${renderInline(c.front)}</strong>
                      <div class="anki-learned-meta">${esc(UI.courseName(c.course_title))}${c.topic_title ? ` · ${esc(c.topic_title)}` : ''} · ${c.is_due ? 'До повторення' : `Наступна через ${esc(c.next_review_in)}`}</div>
                    </div>
                    <button type="button" class="anki-text-action" data-anki-unlearn="${esc(c.card_key)}">Зняти позначку</button>
                  </div>
                `).join('')}
              </div>
            ` : '<p class="anki-empty-box">Поки немає позначених карток.</p>'}
          </details>
        </div>
      </div>
    `;
    if (draft) {
      const form = host.querySelector('[data-anki-add-form]');
      for (const [name, value] of draft) form.elements[name].value = value;
    }
    UI.enhance?.(host);
  }

  // ==========================================================================
  // 3. Distraction-Free Study Interface (#anki/study & #anki/study/:courseId)
  // ==========================================================================
  function initStudySession(session, courseId = null, practiceAll = false) {
    const queue = studyQueue(session, courseId, practiceAll);

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
    if (state === 'new') return '<span class="anki-status is-new">Нова картка</span>';
    if (state === 'learning' || state === 'relearning') return '<span class="anki-status is-learning">У вивченні</span>';
    return '<span class="anki-status">Повторення</span>';
  }

  const ratings = [
    ['again', 'Знову', '1'],
    ['hard', 'Важко', '2'],
    ['good', 'Добре', '3'],
    ['easy', 'Легко', '4'],
  ];

  function renderStudyFace(card, answer) {
    const titleId = answer ? 'anki-answer-label' : 'anki-question-label';
    const hidden = studyState.revealed !== answer ? 'inert aria-hidden="true"' : '';
    return `
      <section class="anki-card-face ${answer ? 'anki-card-back' : 'anki-card-front'}" aria-labelledby="${titleId}" ${hidden}>
        <header class="anki-face-header">
          <h2 class="anki-face-label" id="${titleId}" tabindex="-1">${answer ? 'Відповідь' : 'Питання'}</h2>
          <button type="button" class="anki-learn-toggle" data-anki-toggle-learned="${esc(card.id)}"
                  data-learned="${card.isLearned ? '1' : '0'}" aria-pressed="${Boolean(card.isLearned)}">
            ${icon(card.isLearned ? 'check' : 'bookmark')} ${card.isLearned ? 'Вивчена' : 'Позначити як вивчену'}
          </button>
        </header>
        ${answer ? `<div class="anki-back-prompt">${renderInline(card.front)}</div>` : ''}
        <div class="anki-face-content reader-prose">${renderRich(answer ? card.back : card.front)}</div>
        ${answer && card.sourceCitation ? `<div class="anki-citation">Джерело · ${esc(card.sourceCitation)}</div>` : ''}
      </section>`;
  }

  function renderStudyDock(card, session) {
    if (!studyState.revealed) {
      return `<button type="button" class="primary anki-reveal-btn" data-anki-study-reveal aria-keyshortcuts="Space">
        Показати відповідь <kbd aria-hidden="true">Space</kbd>
      </button>`;
    }
    const preview = engine()?.getSchedulingPreview(card, activeConfig(session));
    return `
      <div class="anki-rating-grid anki-study-ratings" role="group" aria-label="Оцінка відповіді">
        ${ratings.map(([key, label, shortcut]) => `
          <button type="button" class="anki-rate-btn ${key}" data-anki-study-rate="${key}" aria-keyshortcuts="${shortcut}" ${studyState.busy ? 'disabled' : ''}>
            <span class="anki-rate-label">${label}</span>
            <span class="anki-rate-int">${esc(preview?.[key]?.intervalLabelUk || preview?.[key]?.intervalLabel || '')}</span>
            <kbd aria-hidden="true">${shortcut}</kbd>
          </button>`).join('')}
      </div>`;
  }

  function renderStudyView(host, session, focusTarget) {
    if (!host || !host.isConnected || !session) return;
    const total = studyState.queue.length;
    const card = studyState.queue[studyState.idx] || null;
    const courseName = studyState.courseId !== null
      ? (session.courses || []).find(c => Number(c.course_id) === Number(studyState.courseId))?.title || 'Колода курсу'
      : 'Усі колоди';
    const back = `<a class="anki-text-action anki-back-link" href="#anki" aria-keyshortcuts="Escape">${icon('arrow-left')} До колод</a>`;

    if (studyState.complete || !card) {
      const elapsedSec = Math.max(1, Math.round((Date.now() - (studyState.sessionStartedAt || Date.now())) / 1000));
      const mins = Math.floor(elapsedSec / 60);
      const secs = elapsedSec % 60;
      const reviewed = studyState.reviewedInSession;
      const canPractice = studyQueue(session, studyState.courseId, true).length > 0;
      host.innerHTML = `
        <div class="anki-study-shell" data-anki-study-view>
          <section class="anki-study-complete">
            <span class="anki-symbol">${icon(reviewed ? 'check' : 'cards')}</span>
            <h1 tabindex="-1">${reviewed ? 'Сесію завершено' : 'Карток за розкладом немає'}</h1>
            <p>${reviewed ? `${cardsLabel(reviewed)} за ${mins ? `${mins} хв ` : ''}${secs} с` : esc(UI.courseName(courseName))}</p>
            ${reviewed ? `
              <dl class="anki-session-breakdown">
                ${ratings.map(([key, label]) => `<div><dt>${label}</dt><dd>${studyState.ratingsCount[key]}</dd></div>`).join('')}
              </dl>` : ''}
            <div class="anki-complete-actions">
              <a class="primary" href="#anki">Колоди ${icon('arrow')}</a>
              ${canPractice ? `<button type="button" class="secondary" data-anki-cram-course="${studyState.courseId ?? ''}">Повторити поза розкладом</button>` : ''}
            </div>
          </section>
        </div>
      `;
      if (focusTarget) host.querySelector('h1').focus({ preventScroll: true });
      return;
    }

    const progressPct = Math.round(((studyState.idx + (studyState.revealed ? 0.5 : 0)) / total) * 100);
    const cardPosition = `Картка ${studyState.idx + 1} з ${total}`;

    host.innerHTML = `
      <div class="anki-study-shell" data-anki-study-view>
        <header class="anki-study-topbar">
          ${back}
          ${settingsButton(true)}
        </header>
        <div class="anki-study-context">
          <div class="anki-study-progress-meta">
            <h1 tabindex="-1">${esc(UI.courseName(card.courseTitle || courseName))}</h1>
            <span class="anki-card-position">${cardPosition}</span>
          </div>
          <progress class="anki-progress-bar" aria-label="Прогрес сесії" aria-valuetext="${cardPosition}" max="100" value="${progressPct}"></progress>
          <div class="anki-study-topic">
            ${card.topicTitle ? `<span class="anki-topic-name">${esc(card.topicTitle)}</span>` : ''}
            ${stateBadgeHtml(card.state)}
          </div>
        </div>

        <div class="anki-flip-stage">
          <div class="anki-flip-card ${studyState.revealed ? 'is-flipped' : ''}" data-anki-flip-card>
            ${renderStudyFace(card, false)}
            ${renderStudyFace(card, true)}
          </div>
        </div>

        <div class="anki-study-dock">${renderStudyDock(card, session)}</div>
      </div>
    `;
    UI.enhance?.(host);
    if (focusTarget) host.querySelector(focusTarget)?.focus({ preventScroll: true });
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
      renderStudyView(activePageHost, lastSession, '#anki-question-label');
      if (activeDashboardHost?.isConnected) drawDashboardWidget(activeDashboardHost, lastSession);
      if (studyState.complete) {
        const rewards = window.frameElement ? window.parent.HustleRewards : window.HustleRewards;
        const title = activePageHost?.querySelector('.anki-study-complete h1');
        if (rewards && title) {
          const topics = new Set(studyState.queue.map(item => `${item.courseId ?? item.course_id}/${item.topicIndex ?? item.topic_index}`));
          const result = document.createElement('p');
          result.className = 'reward-exercise-result';
          result.role = 'status';
          title.after(result);
          Promise.all([...topics].map(key => {
            const [course, topic] = key.split('/');
            return Number(course) > 0 ? rewards.earn('cards', course, topic) : null;
          })).then(awards => {
            const xp = awards.reduce((sum, award) => sum + (award?.xp || 0), 0);
            const points = awards.reduce((sum, award) => sum + (award?.points || 0), 0);
            result.textContent = xp ? rewards.awardText({ xp, points, level: awards.filter(award => award?.level).at(-1)?.level }) : '';
          }).catch(() => { result.textContent = 'Сесію збережено. Не вдалося зберегти XP.'; });
        }
      }
    } catch (err) {
      studyState.busy = false;
      UI.toast?.(err.message);
      renderStudyView(activePageHost, lastSession, `[data-anki-study-rate="${rating}"]`);
    }
  }

  // ==========================================================================
  // 4. Adaptive Goal & Time Calibration Modal + Advanced FSRS Settings Drawer
  // ==========================================================================
  function openSettingsModal() {
    const frame = window.frameElement;
    const modalDocument = frame?.matches('.paper-course-tools') ? frame.ownerDocument : document;
    const dialog = modalDocument.querySelector('#study-dialog');
    const body = modalDocument.querySelector('#dialog-body');
    if (!dialog || !body) return;
    const trigger = document.activeElement?.closest('[data-anki-open-settings]');

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
      <h2 id="dialog-title">Налаштування Anki</h2>
      <form class="anki-modal-form" data-anki-calibration-form>
        <section class="anki-cal-section">
          <div class="anki-cal-head">
            <label for="anki-retention-range">Ціль запам’ятовування</label>
            <span class="anki-cal-badge" data-cal-retention-label>${retentionPct}%</span>
          </div>
          <input id="anki-retention-range" type="range" name="target_retention_pct" min="80" max="98" step="1" value="${retentionPct}">
          <div class="anki-preset-row">
            ${[85, 90, 95].map(p => `<button type="button" class="anki-preset-btn" aria-pressed="${retentionPct === p}" data-preset-retention="${p}">${p}%</button>`).join('')}
          </div>
          <small>Вища ціль означає частіші повторення.</small>
        </section>

        <section class="anki-cal-section">
          <div class="anki-cal-head">
            <label for="anki-daily-minutes">Час на картки (хв на день)</label>
            <input id="anki-daily-minutes" type="number" name="daily_minutes" min="5" max="240" value="${cfg.dailyMinutes}">
          </div>
          <div class="anki-preset-row">
            ${[10, 20, 30, 45, 60].map(m => `<button type="button" class="anki-preset-btn" aria-pressed="${cfg.dailyMinutes === m}" data-preset-minutes="${m}">${m} хв</button>`).join('')}
          </div>
          <p class="anki-cal-preview" data-cal-preview>Розрахований ліміт нових карток на день — <strong>${cal.newCardsLimit}</strong></p>
        </section>

        <details class="anki-drawer anki-advanced-drawer">
          <summary>${icon('settings')} Розширені параметри FSRS ${icon('chevron-down')}</summary>
          <div class="anki-settings-form">
            <label class="anki-field">
              Нових карток на день
              <input type="number" name="new_cards_limit" min="0" max="100" value="${cfg.newCardsLimit}">
            </label>
            <label class="anki-field">
              Повторень на день
              <input type="number" name="daily_limit" min="1" max="500" value="${cfg.dailyReviewLimit}">
            </label>
            <label class="anki-field">
              Максимальний інтервал (днів)
              <input type="number" name="maximum_interval" min="1" max="36500" value="${cfg.maximumInterval}">
            </label>
            <label class="anki-field">
              Час на одну картку (с)
              <input type="number" step="any" min="5" max="120" name="avg_seconds_per_card" value="${metrics.avgSecondsPerCard || cfg.avgSecondsPerCard}">
            </label>
            <label class="anki-field">
              Кроки вивчення (хв, через кому)
              <input type="text" name="learning_steps" value="${esc((cfg.learningSteps || [1, 10]).join(', '))}">
            </label>
            <label class="anki-field">
              Кроки повторного вивчення (хв, через кому)
              <input type="text" name="relearning_steps" value="${esc((cfg.relearningSteps || [10]).join(', '))}">
            </label>
            <label class="anki-field anki-form-wide">
              Ваги FSRS
              <input type="text" name="fsrs_weights" value="${esc((cfg.weights || []).join(', '))}">
            </label>
            <div class="anki-form-wide anki-form-options">
              <label class="anki-check-row">
                <input type="checkbox" name="include_learned" ${cfg.includeLearned !== false ? 'checked' : ''}>
                Включати вивчені картки
              </label>
              <label class="anki-check-row">
                <input type="checkbox" name="include_new" ${cfg.includeNew !== false ? 'checked' : ''}>
                Включати нові картки
              </label>
              <button type="button" class="anki-text-action" data-reset-fsrs-weights>Відновити типові ваги</button>
            </div>
            ${courses.length ? `
              <fieldset class="anki-form-wide anki-courses-box">
                <legend>Курси для повторення</legend>
                <p class="muted">Без вибору повторюються всі курси.</p>
                ${courses.map(c => `
                  <label class="anki-check-row">
                    <input type="checkbox" name="course_ids" value="${Number(c.course_id)}" ${selectedCourses.has(Number(c.course_id)) ? 'checked' : ''}>
                    ${esc(UI.courseName(c.title))}
                  </label>
                `).join('')}
              </fieldset>
            ` : ''}
          </div>
        </details>

        <div class="anki-modal-footer">
          <button type="button" class="secondary" data-close-anki-modal>Скасувати</button>
          <button type="submit" class="primary">Зберегти</button>
        </div>
        <p id="dialog-error" class="field-error" role="alert" hidden></p>
      </form>
    `;

    const form = body.querySelector('[data-anki-calibration-form]');
    let manualNewOverride = false;
    let manualDailyOverride = false;

    form.addEventListener('invalid', event => {
      const drawer = event.target.closest('details');
      if (drawer) drawer.open = true;
    }, true);

    function recalibrateLive() {
      const retPct = Number(form.elements.target_retention_pct.value || 90);
      const mins = Number(form.elements.daily_minutes.value || 20);
      const secPer = Number(form.elements.avg_seconds_per_card.value || 18);
      form.querySelector('[data-cal-retention-label]').textContent = `${retPct}%`;
      form.querySelectorAll('[data-preset-retention]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.presetRetention) === retPct)));
      form.querySelectorAll('[data-preset-minutes]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.presetMinutes) === mins)));

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
        if (!manualDailyOverride) {
          form.elements.daily_limit.value = String(Math.min(500, Math.max(100, nextCal.totalDailyCapacity)));
        }
        form.querySelector('[data-cal-preview] strong').textContent = nextCal.newCardsLimit;
      }
    }

    form.addEventListener('input', (e) => {
      if (e.target === form.elements.new_cards_limit) {
        manualNewOverride = true;
      } else if (e.target === form.elements.daily_limit) {
        manualDailyOverride = true;
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
        UI.toast?.('Налаштування Anki збережено.');
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

    if (!dialog.open) {
      dialog.showModal();
      const modalWindow = modalDocument.defaultView;
      const closeOnNavigation = () => dialog.close();
      modalWindow.addEventListener('hashchange', closeOnNavigation, { once: true });
      dialog.addEventListener('close', () => {
        modalWindow.removeEventListener('hashchange', closeOnNavigation);
        if (!trigger || frame && !frame.isConnected) return;
        const button = trigger.isConnected ? trigger : document.querySelector('[data-anki-open-settings]');
        button?.focus({ preventScroll: true });
      }, { once: true });
    }
  }

  // ==========================================================================
  // 5. Event Listeners, Keyboard Navigation & Public Mount API
  // ==========================================================================
  function revealStudyCard() {
    if (studyState.revealed) return;
    const flip = activePageHost?.querySelector('[data-anki-flip-card]');
    if (!flip) return;

    studyState.revealed = true;
    const front = flip.querySelector('.anki-card-front');
    const back = flip.querySelector('.anki-card-back');
    front.inert = true;
    front.setAttribute('aria-hidden', 'true');
    back.inert = false;
    back.removeAttribute('aria-hidden');
    flip.classList.add('is-flipped');

    activePageHost.querySelector('.anki-progress-bar').value =
      Math.round(((studyState.idx + 0.5) / studyState.queue.length) * 100);
    const card = studyState.queue[studyState.idx];
    activePageHost.querySelector('.anki-study-dock').innerHTML = renderStudyDock(card, lastSession);
    back.querySelector('.anki-face-label').focus({ preventScroll: true });
  }

  function bindSharedHandlers(host) {
    if (!host || host.dataset.ankiBound) return;
    host.dataset.ankiBound = '1';

    host.addEventListener('click', async (event) => {
      if (event.target.closest('[data-anki-retry]')) {
        if (host.matches('[data-today-anki]')) mount(host.parentElement, activeAccount);
        else mountPage(host, activeAccount);
        return;
      }

      if (event.target.closest('[data-anki-open-settings]')) {
        openSettingsModal();
        return;
      }

      const cramBtn = event.target.closest('[data-anki-cram-course]');
      if (cramBtn) {
        const cid = cramBtn.dataset.ankiCramCourse ? Number(cramBtn.dataset.ankiCramCourse) : null;
        initStudySession(lastSession, cid, true);
        renderStudyView(activePageHost, lastSession, 'h1');
        return;
      }

      if (event.target.closest('[data-anki-study-reveal]')) {
        revealStudyCard();
        return;
      }

      if (!studyState.revealed && event.target.closest('.anki-card-front')
          && !event.target.closest('button, a, code, pre, kbd') && document.getSelection()?.isCollapsed !== false) {
        revealStudyCard();
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
          if (activePageHost?.querySelector('[data-anki-study-view]')) {
            renderStudyView(activePageHost, lastSession, '.anki-card-face:not([inert]) [data-anki-toggle-learned]');
          }
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
          if (activePageHost?.querySelector('[data-anki-overview-page]')) {
            renderCourseOverviewPage(activePageHost, lastSession);
            activePageHost.querySelector('[data-anki-learned-drawer] summary')?.focus({ preventScroll: true });
          }
          if (activeDashboardHost?.isConnected) drawDashboardWidget(activeDashboardHost, lastSession);
        } catch (err) {
          UI.toast?.(err.message);
          unlearnBtn.disabled = false;
        }
        return;
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
        addForm.reset();
        if (activePageHost?.querySelector('[data-anki-overview-page]')) {
          renderCourseOverviewPage(activePageHost, lastSession);
          activePageHost.querySelector('[data-anki-add-form] [name="front"]')?.focus({ preventScroll: true });
        }
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
      if (event.target.closest?.('button:not([data-anki-study-reveal]), a, summary')) return;
      event.preventDefault();
      if (!studyState.revealed) revealStudyCard();
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

  function renderLoadState(host, isDashboard, message) {
    host.innerHTML = `
      <div class="anki-load-state ${isDashboard ? 'anki-summary-card' : 'anki-page'}">
        <div class="anki-summary-main">
          <span class="anki-symbol">${icon('cards')}</span>
          <div>
            ${isDashboard ? '<h2>Картки Anki</h2>' : '<h1>Картки Anki</h1>'}
            ${message ? `<p role="alert">${esc(message)}</p>` : '<p role="status">Завантажуємо картки…</p>'}
          </div>
        </div>
        ${message ? '<button type="button" class="secondary" data-anki-retry>Спробувати ще раз</button>' : ''}
      </div>
    `;
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
      renderLoadState(host, true);
    }

    try {
      const data = await refreshSession(null, false);
      if (host.isConnected) drawDashboardWidget(host, data);
    } catch (err) {
      if (host.isConnected) {
        renderLoadState(host, true, err.message);
      }
    }
  }

  async function mountPage(main, account) {
    if (account) activeAccount = account;
    activePageHost = main;
    bindSharedHandlers(main);

    const hash = location.hash;
    const [path, query = ''] = hash.slice(1).split('?');
    const parts = path.split('/');
    const params = new URLSearchParams(query);
    const isStudy = parts[1] === 'study';
    const courseId = isStudy && parts[2] !== undefined && parts[2] !== '' && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null;
    const practiceAll = params.get('all') === '1';

    renderLoadState(main, false);
    try {
      const session = await refreshSession(null, practiceAll);
      if (!main.isConnected || location.hash !== hash) return;
      if (isStudy) {
        initStudySession(session, courseId, practiceAll);
        renderStudyView(main, session, 'h1');
      } else {
        renderCourseOverviewPage(main, session);
      }
    } catch (err) {
      if (main.isConnected && location.hash === hash) {
        renderLoadState(main, false, err.message);
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
