/* Anki Spaced Repetition Dashboard Block & Course Flashcard Learned Sync */
(() => {
  const { escape: esc } = UI;
  let lastSession = null;
  let activeState = null;

  const math = value => (UI.inlineMath ? UI.inlineMath(value) : esc(value || ''));

  async function apiReq(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(typeof data?.detail === 'string' ? data.detail : 'Не вдалося оновити Anki.');
    }
    return data;
  }

  function currentCard(state) {
    if (!state.session?.queue?.length) return null;
    if (state.idx >= state.session.queue.length) state.idx = 0;
    return state.session.queue[state.idx] || null;
  }

  function renderSettingsForm(session) {
    const s = session.settings || {};
    const selectedCourses = new Set((s.course_ids || []).map(Number));
    const courses = session.courses || [];
    return `
      <form class="anki-settings-form" data-anki-settings-form>
        <label class="anki-field">
          Ліміт карток за сесію
          <input type="number" name="daily_limit" min="1" max="100" value="${Number(s.daily_limit || 20)}">
        </label>
        <label class="anki-field">
          «Знову» (хв)
          <input type="number" name="again_minutes" min="1" max="1440" value="${Number(s.again_minutes || 10)}">
        </label>
        <label class="anki-field">
          «Важко» (хв)
          <input type="number" name="hard_minutes" min="5" max="2880" value="${Number(s.hard_minutes || 720)}">
        </label>
        <label class="anki-field">
          «Добре» (днів)
          <input type="number" step="0.5" min="0.5" max="60" name="good_days" value="${Number(s.good_days || 1)}">
        </label>
        <label class="anki-field">
          «Легко» (днів)
          <input type="number" step="0.5" min="1" max="120" name="easy_days" value="${Number(s.easy_days || 4)}">
        </label>
        <label class="anki-field">
          Темп інтервалів
          <select name="interval_multiplier">
            <option value="0.5" ${Number(s.interval_multiplier) === 0.5 ? 'selected' : ''}>0.5x (Частіше)</option>
            <option value="1" ${Number(s.interval_multiplier || 1) === 1 ? 'selected' : ''}>1.0x (Стандарт Anki)</option>
            <option value="1.5" ${Number(s.interval_multiplier) === 1.5 ? 'selected' : ''}>1.5x (Спокійніше)</option>
          </select>
        </label>
        <div style="grid-column:1/-1; display:flex; flex-wrap:wrap; gap:1rem;">
          <label class="anki-check-row">
            <input type="checkbox" name="include_learned" ${s.include_learned !== false ? 'checked' : ''}>
            Включати дефініції, позначені як вивчені
          </label>
          <label class="anki-check-row">
            <input type="checkbox" name="include_new" ${s.include_new !== false ? 'checked' : ''}>
            Включати нові картки курсів
          </label>
        </div>
        ${courses.length ? `
          <div class="anki-courses-box">
            <span style="width:100%; font-size:.77rem; font-weight:700; color:#5d4d40;">Курси в колоді (порожньо = усі):</span>
            ${courses.map(c => `
              <label class="anki-check-row">
                <input type="checkbox" name="course_ids" value="${Number(c.course_id)}" ${selectedCourses.has(Number(c.course_id)) ? 'checked' : ''}>
                ${esc(c.title)} (${c.cards_count})
              </label>
            `).join('')}
          </div>
        ` : ''}
        <div style="grid-column:1/-1; display:flex; align-items:center; gap:.75rem; flex-wrap:wrap;">
          <button type="submit" class="primary">Зберегти налаштування</button>
          <span role="status" class="muted" data-anki-settings-status style="font-size:.8rem;"></span>
        </div>
      </form>
    `;
  }

  function renderLearnedList(session) {
    const list = session.learned_cards || [];
    const courses = session.courses || [];
    return `
      <form class="anki-settings-form" data-anki-add-form style="margin-bottom:.75rem;">
        <label class="anki-field">
          Новий термін / питання
          <input type="text" name="front" required placeholder="Напр.: Теорема Баєса">
        </label>
        <label class="anki-field">
          Визначення / відповідь
          <input type="text" name="back" required placeholder="Оновлення апостеріорної ймовірності...">
        </label>
        ${courses.length ? `
          <label class="anki-field">
            Курс
            <select name="course_id">
              <option value="0">Власні визначення</option>
              ${courses.map(c => `<option value="${Number(c.course_id)}">${esc(c.title)}</option>`).join('')}
            </select>
          </label>
        ` : ''}
        <div style="display:flex; align-items:flex-end; gap:.5rem;">
          <button type="submit" class="secondary">+ Додати як вивчену</button>
        </div>
      </form>
      ${list.length ? `
        <div class="anki-learned-list">
          ${list.map(c => `
            <div class="anki-learned-row">
              <div>
                <strong>${math(c.front)}</strong>
                <div class="anki-learned-meta">${esc(c.course_title)}${c.topic_title ? ` · ${esc(c.topic_title)}` : ''} · Повторення: ${c.is_due ? 'Зараз' : `через ${esc(c.next_review_in)}`}</div>
              </div>
              <button type="button" class="text-button" data-anki-unlearn="${esc(c.card_key)}">Зняти позначку</button>
            </div>
          `).join('')}
        </div>
      ` : '<p class="muted" style="margin:.4rem 0 0; font-size:.82rem;">Поки що немає позначених як вивчених дефініцій.</p>'}
    `;
  }

  function draw(state) {
    const host = state.host;
    if (!host || !host.isConnected) return;
    const session = state.session;
    if (!session) return;

    const stats = session.stats || {};
    const card = currentCard(state);
    const previews = card?.interval_previews || {};

    host.innerHTML = `
      <div class="anki-panel">
        <div class="anki-header">
          <div class="anki-title-wrap">
            <h2>🃏 Інтервальне повторення Anki</h2>
            <div class="anki-stats-row">
              <span class="anki-stat-pill due">До повторення: ${stats.due_now ?? 0}</span>
              <span class="anki-stat-pill learned">Вивчених дефініцій: ${stats.learned_count ?? 0}</span>
              <span class="anki-stat-pill">Повторено сьогодні: ${stats.reviewed_today ?? 0}</span>
            </div>
          </div>
          <div class="anki-header-actions">
            ${(!stats.due_now && stats.deck_size > 0 && !session.practice_all)
              ? `<button type="button" class="secondary" data-anki-practice-all>Повторити поза розкладом</button>`
              : ''}
            ${session.practice_all
              ? `<button type="button" class="text-button" data-anki-due-only>Лише за розкладом</button>`
              : ''}
          </div>
        </div>

        ${card ? `
          <div class="anki-card-box" data-anki-card="${esc(card.card_key)}">
            <div class="anki-card-meta">
              <span class="anki-card-context">${esc(card.course_title)}${card.topic_title ? ` · ${esc(card.topic_title)}` : ''}${card.repetitions ? ` · Повторів: ${card.repetitions}` : ''}</span>
              <button type="button"
                      class="anki-learn-toggle ${card.is_learned ? 'is-learned' : ''}"
                      data-anki-toggle-learned="${esc(card.card_key)}"
                      data-learned="${card.is_learned ? '1' : '0'}">
                ${card.is_learned ? '✓ Позначено як вивчену' : '○ Позначити як вивчену'}
              </button>
            </div>

            <div class="anki-front">${math(card.front)}</div>

            ${state.revealed ? `
              <div class="anki-back">
                <div>${math(card.back)}</div>
                ${card.source_citation ? `<div class="anki-citation">Джерело: ${esc(card.source_citation)}</div>` : ''}
              </div>
              <div class="anki-rating-grid" role="group" aria-label="Оціни, наскільки добре знаєш картку">
                <button type="button" class="anki-rate-btn again" data-anki-rate="again">
                  <span>Знову</span>
                  <span class="anki-rate-int">${esc(previews.again || '10 хв')}</span>
                </button>
                <button type="button" class="anki-rate-btn hard" data-anki-rate="hard">
                  <span>Важко</span>
                  <span class="anki-rate-int">${esc(previews.hard || '12 год')}</span>
                </button>
                <button type="button" class="anki-rate-btn good" data-anki-rate="good">
                  <span>Добре</span>
                  <span class="anki-rate-int">${esc(previews.good || '1 д')}</span>
                </button>
                <button type="button" class="anki-rate-btn easy" data-anki-rate="easy">
                  <span>Легко</span>
                  <span class="anki-rate-int">${esc(previews.easy || '4 д')}</span>
                </button>
              </div>
            ` : `
              <div style="display:flex; gap:.6rem; flex-wrap:wrap;">
                <button type="button" class="primary" data-anki-reveal>Показати відповідь</button>
              </div>
            `}
          </div>
        ` : `
          <div class="anki-empty-box">
            <div>
              <strong>${stats.deck_size ? 'Усі заплановані картки на цей момент повторено!' : 'У вибраній колоді поки немає карток.'}</strong>
              <p class="muted" style="margin:.25rem 0 0; font-size:.83rem;">
                ${stats.next_due_in ? `Наступна картка за інтервалом з’явиться приблизно через ${esc(stats.next_due_in)}.` : 'Згенеруй картки в темах курсів або додай власне визначення нижче.'}
              </p>
            </div>
            ${stats.deck_size ? `<button type="button" class="secondary" data-anki-practice-all>Повторити поза розкладом →</button>` : ''}
          </div>
        `}

        <details class="anki-drawer" ${state.openSettings ? 'open' : ''} data-anki-settings-drawer>
          <summary>⚙ Налаштувати колоду й інтервали</summary>
          ${renderSettingsForm(session)}
        </details>

        <details class="anki-drawer" ${state.openLearned ? 'open' : ''} data-anki-learned-drawer>
          <summary>📖 Вивчені дефініції та власні картки (${stats.learned_count ?? 0})</summary>
          ${renderLearnedList(session)}
        </details>
      </div>
    `;

    UI.enhance?.(host);
  }

  async function refresh(state, practiceAll = false) {
    try {
      const data = await apiReq(`/api/workspace/anki/session?practice_all=${practiceAll ? 'true' : 'false'}`);
      lastSession = data;
      state.session = data;
      state.revealed = false;
      state.idx = 0;
      draw(state);
    } catch (err) {
      if (state.host?.isConnected) {
        state.host.innerHTML = `<div class="anki-panel"><p role="alert" class="field-error">${esc(err.message)}</p></div>`;
      }
    }
  }

  function mount(root) {
    const host = root?.querySelector('[data-today-anki]');
    if (!host) return;

    const state = {
      host,
      session: lastSession,
      revealed: false,
      idx: 0,
      practiceAll: false,
      openSettings: false,
      openLearned: false,
    };
    activeState = state;

    if (lastSession) {
      draw(state);
    } else {
      host.innerHTML = `<div class="anki-panel"><p class="muted" role="status" style="margin:0;">Готуємо картки Anki…</p></div>`;
    }
    refresh(state, false);

    host.addEventListener('toggle', (event) => {
      if (event.target.matches('[data-anki-settings-drawer]')) state.openSettings = event.target.open;
      if (event.target.matches('[data-anki-learned-drawer]')) state.openLearned = event.target.open;
    }, true);

    host.addEventListener('click', async (event) => {
      if (event.target.closest('[data-anki-reveal]')) {
        state.revealed = true;
        draw(state);
        return;
      }

      if (event.target.closest('[data-anki-practice-all]')) {
        state.practiceAll = true;
        await refresh(state, true);
        return;
      }

      if (event.target.closest('[data-anki-due-only]')) {
        state.practiceAll = false;
        await refresh(state, false);
        return;
      }

      const rateBtn = event.target.closest('[data-anki-rate]');
      if (rateBtn) {
        const card = currentCard(state);
        if (!card) return;
        const rating = rateBtn.dataset.ankiRate;
        host.querySelectorAll('[data-anki-rate]').forEach(b => { b.disabled = true; });
        try {
          const res = await apiReq('/api/workspace/anki/cards/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card_key: card.card_key, rating }),
          });
          lastSession = res.session;
          state.session = res.session;
          state.revealed = false;
          state.idx = 0;
          if (state.practiceAll && !state.session.queue?.length) {
            await refresh(state, true);
          } else {
            draw(state);
          }
          UI.toast?.(`Заплановано наступне повторення: через ${res.next_review_in}`);
        } catch (err) {
          UI.toast?.(err.message);
          draw(state);
        }
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
          state.session = res.session;
          draw(state);
          UI.toast?.(nextLearned ? 'Дефініцію позначено як вивчену для Anki.' : 'Позначку вивченої знято.');
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
          state.session = res.session;
          draw(state);
        } catch (err) {
          UI.toast?.(err.message);
          unlearnBtn.disabled = false;
        }
      }
    });

    host.addEventListener('submit', async (event) => {
      const settingsForm = event.target.closest('[data-anki-settings-form]');
      if (settingsForm) {
        event.preventDefault();
        const fd = new FormData(settingsForm);
        const statusEl = settingsForm.querySelector('[data-anki-settings-status]');
        const courseIds = fd.getAll('course_ids').map(Number).filter(n => n > 0);
        const payload = {
          daily_limit: Number(fd.get('daily_limit') || 20),
          again_minutes: Number(fd.get('again_minutes') || 10),
          hard_minutes: Number(fd.get('hard_minutes') || 720),
          good_days: Number(fd.get('good_days') || 1),
          easy_days: Number(fd.get('easy_days') || 4),
          interval_multiplier: Number(fd.get('interval_multiplier') || 1),
          include_learned: settingsForm.elements.include_learned?.checked ?? true,
          include_new: settingsForm.elements.include_new?.checked ?? true,
          course_ids: courseIds,
        };
        if (statusEl) statusEl.textContent = 'Зберігаємо…';
        try {
          const session = await apiReq('/api/workspace/anki/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          lastSession = session;
          state.session = session;
          state.revealed = false;
          state.idx = 0;
          draw(state);
          UI.toast?.('Налаштування Anki збережено.');
        } catch (err) {
          if (statusEl) statusEl.textContent = err.message;
        }
        return;
      }

      const addForm = event.target.closest('[data-anki-add-form]');
      if (addForm) {
        event.preventDefault();
        const front = addForm.elements.front?.value?.trim() || '';
        const back = addForm.elements.back?.value?.trim() || '';
        const courseId = Number(addForm.elements.course_id?.value || 0);
        if (!front || !back) return;
        try {
          const res = await apiReq('/api/workspace/anki/cards', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ front, back, course_id: courseId, is_learned: true }),
          });
          lastSession = res.session;
          state.session = res.session;
          draw(state);
          UI.toast?.('Визначення додано до вивченої колоди Anki.');
        } catch (err) {
          UI.toast?.(err.message);
        }
      }
    });
  }

  async function toggleLearnedFromCourse(payload) {
    const res = await apiReq('/api/workspace/anki/cards/learned', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res?.session) {
      lastSession = res.session;
      if (activeState?.host?.isConnected) {
        activeState.session = res.session;
        draw(activeState);
      }
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
    toggleLearnedFromCourse,
    isLearnedSync,
  };
})();
