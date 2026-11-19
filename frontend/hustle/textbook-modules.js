/* Structured Textbook Modules, Video Concept Jump Rewards (+XP), Module Self-Tests & AI Tutor Gate (>= 4/10), Topic Scores & Mistakes */
(() => {
  const { escape: esc, icon } = UI;
  const progressCache = new Map();
  const inlineQuizSelections = new Map(); // `${courseId}:${topicIndex}:${moduleId}:${qIdx}` -> optionIdx
  const inlineQuizResults = new Map(); // `${courseId}:${topicIndex}:${moduleId}` -> server response
  const inlineTutorResults = new Map(); // `${courseId}:${topicIndex}:${moduleId}` -> server response
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  function moduleIdFor(block, idx) {
    return String(block?.module_id || block?.chunk_id || `sec-${idx}`);
  }

  function topicIndexFor(bundle, topic, node) {
    if (topic && topic.topic_index != null) return Number(topic.topic_index);
    if (node && node.topic_index != null) return Number(node.topic_index);
    return Number(node?.section_index ?? 1);
  }

  function buildTopicUrl(courseId, topicIndex, nodeId) {
    const params = new URLSearchParams();
    if (nodeId) params.set('node', nodeId);
    const from = UI.route().from;
    if (from) params.set('from', from);
    const qs = params.toString();
    return `#course/${encodeURIComponent(courseId)}/reading/${encodeURIComponent(topicIndex)}${qs ? '?' + qs : ''}`;
  }

  function buildModuleUrl(courseId, topicIndex, moduleId, nodeId) {
    const params = new URLSearchParams();
    if (nodeId) params.set('node', nodeId);
    params.set('module', moduleId);
    const from = UI.route().from;
    if (from) params.set('from', from);
    return `#course/${encodeURIComponent(courseId)}/reading/${encodeURIComponent(topicIndex)}?${params.toString()}`;
  }

  async function apiReq(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(typeof data?.detail === 'string' ? data.detail : 'Не вдалося виконати запит.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function fetchProgress(courseId, forceRefresh = false) {
    const key = String(courseId);
    if (!forceRefresh && progressCache.has(key)) {
      return progressCache.get(key);
    }
    const data = await apiReq(`/api/workspace/courses/${encodeURIComponent(courseId)}/learning-progress`);
    progressCache.set(key, data);
    return data;
  }

  function findTopicProgress(progress, topicIndex) {
    if (!progress?.topics) return null;
    return progress.topics.find(t => Number(t.topic_index) === Number(topicIndex)) || null;
  }

  function findModuleProgress(topicProg, moduleId) {
    if (!topicProg?.modules) return null;
    return topicProg.modules.find(m => String(m.module_id) === String(moduleId)) || null;
  }

  function quizzesForModule(block, topic, idx, totalBlocks) {
    if (block?.module_quizzes?.length) return block.module_quizzes;
    const all = topic?.quizzes || [];
    if (!all.length) return [];
    const per = Math.max(2, Math.ceil(all.length / Math.max(1, totalBlocks)));
    const start = (idx * per) % all.length;
    const slice = [];
    for (let i = 0; i < Math.min(per, all.length); i++) {
      slice.push(all[(start + i) % all.length]);
    }
    return slice;
  }

  function tutorQuestionFor(block, topicTitle) {
    if (block?.tutor_question) return block.tutor_question;
    return `Поясніть своїми словами ключову ідею, визначення та практичне застосування розділу «${block?.heading || topicTitle}».`;
  }

  function renderSummaryCard(courseId, topicIndex, topicTitle, summaryText, topicProg, extraBtnHtml = '') {
    const score = topicProg?.score_percent;
    const xp = topicProg?.xp_earned || 0;
    const doneCount = topicProg?.modules_completed || 0;
    const totalCount = topicProg?.modules_total || 0;
    const pct = score != null ? score : 0;

    return `
      <section class="tm-summary-card" data-tm-summary="${esc(courseId)}:${esc(topicIndex)}">
        <div class="tm-summary-top">
          <div class="tm-score-row">
            <span class="tm-score-pill" data-tm-topic-score>
              📊 Скор теми: <strong>${score != null ? `${score}%` : '0%'}</strong> (${doneCount}/${totalCount} модулів)
            </span>
            <progress class="tm-progress" value="${pct}" max="100" aria-label="Прогрес проходження теми"></progress>
            <span class="tm-xp-pill" data-tm-topic-xp>⚡ ${xp} XP</span>
          </div>
          ${extraBtnHtml}
        </div>
        ${summaryText ? `<p class="tm-topic-summary-text"><strong>Самері теми:</strong> ${UI.inlineMath ? UI.inlineMath(summaryText) : esc(summaryText)}</p>` : ''}
      </section>
    `;
  }

  function renderModuleCards(courseId, topicIndex, blocks, nodeId, topicProg) {
    if (!blocks.length) return '';
    return `
      <section class="tm-modules-section" aria-label="Структура підручника теми">
        <h3 style="margin:0 0 .35rem;">📖 Модулі підручника теми</h3>
        <p class="muted" style="margin:0 0 .75rem; font-size:.88rem;">Обери розділ, щоб відкрити його окрему сторінку з матеріалами, відео-фрагментами, тестами та перевіркою AI-тютора (мінімум 4/10).</p>
        <div class="tm-modules-list">
          ${blocks.map((b, idx) => {
            const mid = moduleIdFor(b, idx);
            const mp = findModuleProgress(topicProg, mid);
            const url = buildModuleUrl(courseId, topicIndex, mid, nodeId);
            const isDone = Boolean(mp?.completed);
            const vcCount = (b.video_concepts || []).length;
            const tutorScore = mp?.tutor_score;
            const qPassed = Boolean(mp?.quizzes_passed);
            const desc = b.short_description || (b.key_takeaways?.[0] || '');

            return `
              <a class="tm-module-card ${isDone ? 'is-completed' : ''}" href="${url}">
                <span class="tm-mod-num">${isDone ? '✓' : idx + 1}</span>
                <div class="tm-mod-body">
                  <h3>${esc(b.heading)}</h3>
                  ${desc ? `<p>${UI.inlineMath ? UI.inlineMath(desc) : esc(desc)}</p>` : ''}
                  <div class="tm-mod-badges">
                    ${isDone ? '<span class="tm-badge ok">✓ Зараховано</span>' : '<span class="tm-badge">Потребує перевірки</span>'}
                    ${vcCount ? `<span class="tm-badge video">🎬 ${vcCount} відео-концептів</span>` : ''}
                    ${qPassed ? '<span class="tm-badge ok">🧪 Тести пройдено</span>' : ''}
                    ${tutorScore != null ? `<span class="tm-badge tutor">🤖 Тютор: ${tutorScore}/10</span>` : ''}
                  </div>
                </div>
                <span aria-hidden="true">${icon('arrow')}</span>
              </a>
            `;
          }).join('')}
        </div>
      </section>
    `;
  }

  function renderDedicatedModulePage(bundle, topic, blocks, activeIdx, node, topicProg) {
    const courseId = bundle.course.course_id;
    const topicIndex = topicIndexFor(bundle, topic, node);
    const nodeId = node?.id || '';
    const block = blocks[activeIdx];
    const moduleId = moduleIdFor(block, activeIdx);
    const mp = findModuleProgress(topicProg, moduleId);
    const prevBlock = activeIdx > 0 ? blocks[activeIdx - 1] : null;
    const nextBlock = activeIdx < blocks.length - 1 ? blocks[activeIdx + 1] : null;
    const backUrl = buildTopicUrl(courseId, topicIndex, nodeId);

    const watchedSet = new Set(mp?.watched_concepts || []);
    const concepts = block.video_concepts || [];
    const math = val => (UI.inlineMath ? UI.inlineMath(val) : esc(val));

    const quizzes = quizzesForModule(block, topic, activeIdx, blocks.length);
    window.__hustleActiveModuleQuizzes = quizzes;
    const qCacheKey = `${courseId}:${topicIndex}:${moduleId}`;
    const savedQuizRes = inlineQuizResults.get(qCacheKey);
    const savedTutorRes = inlineTutorResults.get(qCacheKey) || (mp?.tutor_score != null ? {
      score: mp.tutor_score,
      passed: mp.tutor_passed,
      feedback: mp.tutor_feedback,
      expected_10_of_10: mp.tutor_expected_10,
      mistakes: [],
    } : null);

    const tutorQ = tutorQuestionFor(block, topic?.title || node?.title || '');
    const isCompleted = Boolean(mp?.completed);

    return `
      <div class="tm-module-page" data-tm-module-page data-course-id="${esc(courseId)}" data-topic-index="${esc(topicIndex)}" data-module-id="${esc(moduleId)}" data-node-id="${esc(nodeId)}">
        <nav class="tm-module-nav-bar" aria-label="Навігація по модулю">
          <a class="text-button" href="${backUrl}">← Усі модулі теми (${blocks.length})</a>
          <div style="display:flex; gap:.5rem; flex-wrap:wrap;">
            ${prevBlock ? `<a class="secondary" href="${buildModuleUrl(courseId, topicIndex, moduleIdFor(prevBlock, activeIdx - 1), nodeId)}">← Попередній</a>` : ''}
            ${nextBlock ? `<a class="secondary" href="${buildModuleUrl(courseId, topicIndex, moduleIdFor(nextBlock, activeIdx + 1), nodeId)}">Наступний →</a>` : ''}
          </div>
        </nav>

        ${renderSummaryCard(courseId, topicIndex, topic?.title || node?.title || '', topic?.topic_summary || node?.topic_summary || '', topicProg)}

        <article class="topic-card reading-paper">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:.75rem; flex-wrap:wrap; margin-bottom:.65rem;">
            <div>
              <span class="tm-badge">Модуль ${activeIdx + 1} з ${blocks.length}</span>
              <h2 style="margin:.35rem 0 0;">${esc(block.heading)}</h2>
            </div>
            <button class="secondary" data-oral-defense data-course-id="${esc(courseId)}" data-topic-index="${esc(topicIndex)}" data-node-id="${esc(nodeId)}" data-topic-title="${esc(block.heading)}">🎙️ Усний захист</button>
          </div>

          ${concepts.length ? `
            <section class="tm-video-concepts" aria-label="Відеоконцепти цього модуля">
              <div class="tm-video-concepts-head">
                <h3>🎬 Розбір концептів у відеолекції (перейди по таймкоду за бонус +5 XP)</h3>
                <span class="tm-xp-pill">Бонус за відео: +${mp?.video_bonus_points || 0} XP</span>
              </div>
              ${concepts.map(vc => {
                const isWatched = watchedSet.has(vc.id);
                return `
                  <div class="tm-vc-item">
                    <div class="tm-vc-info">
                      <strong>Ми зараз розбираємо концепт: «${esc(vc.concept_title)}» (${esc(vc.timecode)})</strong>
                      ${vc.summary ? `<p>${math(vc.summary)}</p>` : ''}
                    </div>
                    <a class="tm-vc-watch-btn ${isWatched ? 'is-watched' : ''}"
                       href="${esc(vc.youtube_url)}"
                       target="_blank"
                       rel="noopener noreferrer"
                       data-tm-video-watch
                       data-concept-id="${esc(vc.id)}"
                       data-concept-title="${esc(vc.concept_title)}">
                      ${isWatched ? '✓ Переглянуто (+5 XP)' : `▶ Дивитись на YouTube (${esc(vc.timecode)}) · +5 XP ↗`}
                    </a>
                  </div>
                `;
              }).join('')}
            </section>
          ` : ''}

          <div class="reader-prose" style="margin-top:1rem;">
            ${UI.markdown(block.explanation_markdown)}
          </div>

          ${block.key_takeaways?.length ? `
            <aside class="reader-keypoints" style="margin-top:1rem;">
              <h4>📌 Головні тези модуля</h4>
              <ul>${block.key_takeaways.map(p => `<li>${math(p)}</li>`).join('')}</ul>
            </aside>
          ` : ''}

          ${block.mermaid_diagram ? `<figure class="diagram" data-diagram="${esc(block.mermaid_diagram)}" aria-label="Схема модуля"></figure>` : ''}
        </article>

        <!-- Knowledge Check Gate for this Submodule -->
        <section class="tm-gate-grid" aria-label="Зарахування підблоку">
          <!-- 1. Module Self-Tests -->
          <div class="tm-gate-box" data-tm-quiz-box>
            <div class="tm-gate-head">
              <h3>🧪 Крок 1: Селф-тести підблоку</h3>
              ${mp?.quizzes_passed ? `<span class="tm-badge ok">✓ Пройдено (${mp.quizzes_correct}/${mp.quizzes_total})</span>` : '<span class="tm-badge">Потрібно для зарахування</span>'}
            </div>

            ${quizzes.length ? `
              <div class="tm-quiz-list" style="display:flex; flex-direction:column; gap:.75rem;">
                ${quizzes.map((q, qIdx) => {
                  const selKey = `${qCacheKey}:${qIdx}`;
                  const chosen = inlineQuizSelections.has(selKey) ? inlineQuizSelections.get(selKey) : null;
                  const resItem = savedQuizRes?.results?.[qIdx];
                  return `
                    <div class="tm-quiz-item" data-tm-q-idx="${qIdx}">
                      <strong style="font-size:.95rem;">${qIdx + 1}. ${math(q.question)}</strong>
                      <div class="tm-quiz-opts">
                        ${(q.options || []).map((opt, optIdx) => {
                          let cls = 'tm-quiz-opt';
                          if (resItem) {
                            if (optIdx === q.correct_index) cls += ' is-right';
                            else if (optIdx === resItem.chosen_index && !resItem.is_correct) cls += ' is-wrong';
                          }
                          return `
                            <label class="${cls}">
                              <input type="radio" name="tm-q-${esc(moduleId)}-${qIdx}" value="${optIdx}" data-tm-quiz-opt="${qIdx}" ${chosen === optIdx ? 'checked' : ''}>
                              <span>${math(opt)}</span>
                            </label>
                          `;
                        }).join('')}
                      </div>
                      ${resItem ? `<div class="muted" style="font-size:.84rem;">${resItem.is_correct ? '✅ Правильно! ' : '❌ Помилка. '}${math(q.explanation || '')}</div>` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
              <div style="display:flex; align-items:center; gap:.75rem; flex-wrap:wrap;">
                <button type="button" class="primary" data-tm-quiz-submit>Перевірити селф-тести →</button>
                <span class="field-error" role="alert" data-tm-quiz-err></span>
              </div>
            ` : '<p class="muted" style="margin:0;">Для цього модуля ще не згенеровано тестів — онови матеріали теми через AI.</p>'}
          </div>

          <!-- 2. AI Tutor Comprehension Check (>= 4/10) -->
          <div class="tm-gate-box" data-tm-tutor-box>
            <div class="tm-gate-head">
              <h3>🤖 Крок 2: Відповідь AI-тютору (мінімум 4/10)</h3>
              ${mp?.tutor_passed ? `<span class="tm-badge ok">✓ Зараховано (${mp.tutor_score}/10)</span>` : mp?.tutor_score != null ? `<span class="tm-badge" style="background:#ffe4e6;color:#9f1239;">Оцінка ${mp.tutor_score}/10 (потрібно ≥ 4)</span>` : '<span class="tm-badge tutor">Поріг: 4/10</span>'}
            </div>

            <div class="tm-tutor-prompt">${math(tutorQ)}</div>

            <form data-tm-tutor-form style="display:flex; flex-direction:column; gap:.7rem;">
              <textarea class="tm-tutor-textarea" name="answer_text" placeholder="Поясни своїми словами або надиктуй голосом…"></textarea>
              <div style="display:flex; gap:.6rem; flex-wrap:wrap; align-items:center;">
                <button type="submit" class="primary" data-tm-tutor-submit>Перевірити відповідь у AI-тютора →</button>
                ${SpeechRec ? `<button type="button" class="secondary" data-tm-tutor-voice>🎙️ Надиктувати голосом</button>` : ''}
                <span class="field-error" role="alert" data-tm-tutor-err></span>
              </div>
            </form>

            ${savedTutorRes ? `
              <div class="tm-tutor-result ${savedTutorRes.passed ? 'passed' : 'failed'}">
                <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:.5rem;">
                  <strong>Оцінка AI-тютора: ${savedTutorRes.score}/10 (${savedTutorRes.passed ? 'Зараховано ✓' : 'Недостатньо — потрібно мінімум 4/10'})</strong>
                </div>
                ${savedTutorRes.feedback ? `<div>${UI.markdown(savedTutorRes.feedback)}</div>` : ''}
                ${savedTutorRes.mistakes?.length ? `
                  <div>
                    <strong>Допущені помилки:</strong>
                    <ul style="margin:.35rem 0 0; padding-left:1.15rem;">
                      ${savedTutorRes.mistakes.map(m => `<li>${esc(m.mistake)}${m.correction ? ` → <em>${esc(m.correction)}</em>` : ''}</li>`).join('')}
                    </ul>
                  </div>
                ` : ''}
                ${savedTutorRes.expected_10_of_10 && (!savedTutorRes.passed || savedTutorRes.score < 10) ? `
                  <div class="tm-expected-10">
                    <strong>🌟 Очікувана відповідь для 10/10:</strong>
                    <div style="margin-top:.3rem;">${UI.markdown(savedTutorRes.expected_10_of_10)}</div>
                  </div>
                ` : ''}
              </div>
            ` : ''}
          </div>
        </section>

        ${isCompleted ? `
          <div class="tm-completion-banner">
            <div>
              <strong>🎉 Підблок «${esc(block.heading)}» зараховано!</strong>
              <p style="margin:.2rem 0 0; font-size:.88rem;">Ти успішно склав селф-тести та набрав ${mp?.tutor_score}/10 у AI-тютора.</p>
            </div>
            ${nextBlock ? `<a class="primary" href="${buildModuleUrl(courseId, topicIndex, moduleIdFor(nextBlock, activeIdx + 1), nodeId)}">Наступний модуль →</a>` : `<a class="primary" href="${backUrl}">Повернутися до теми →</a>`}
          </div>
        ` : ''}
      </div>
    `;
  }

  function renderDashboardProgress(progress, courseId) {
    if (!progress || !progress.topics?.length) return '';
    const overall = progress.overall_score_percent;
    const totalMistakes = progress.mistakes_by_topic?.reduce((s, t) => s + t.unresolved_count, 0) || 0;

    return `
      <section class="tm-dashboard-section" aria-label="Прогрес по темах, самері та помилки">
        <div class="tm-dash-header">
          <div>
            <h2>📚 Теми курсу: прогрес, самері та помилки</h2>
            <p class="muted" style="margin:.2rem 0 0; font-size:.86rem;">
              ${overall != null ? `Середній скор проходження: <strong>${overall}%</strong> · ` : ''}
              Нараховано бонусів: <strong>⚡ ${progress.total_xp || 0} XP</strong>
              ${totalMistakes ? ` · Активних помилок: <strong>${totalMistakes}</strong>` : ''}
            </p>
          </div>
        </div>

        <div class="tm-dash-topics">
          ${progress.topics.map(t => {
            const pct = t.score_percent != null ? t.score_percent : 0;
            const topicUrl = buildTopicUrl(courseId, t.topic_index);
            return `
              <article class="tm-dash-topic-card">
                <div class="tm-dash-topic-head">
                  <div>
                    <h3><a href="${topicUrl}" style="text-decoration:none; color:inherit;">${esc(t.topic_title)}</a></h3>
                    <div class="tm-score-row" style="margin-top:.35rem;">
                      <span class="tm-score-pill">Скор: <strong>${t.score_percent != null ? `${t.score_percent}%` : '0%'}</strong> (${t.modules_completed}/${t.modules_total} модулів)</span>
                      <progress class="tm-progress" value="${pct}" max="100" aria-label="Скор теми ${esc(t.topic_title)}"></progress>
                      ${t.xp_earned ? `<span class="tm-xp-pill">⚡ ${t.xp_earned} XP</span>` : ''}
                    </div>
                  </div>
                  <a class="secondary" href="${topicUrl}">Відкрити модулі →</a>
                </div>

                ${t.topic_summary ? `<p class="tm-topic-summary-text">${UI.inlineMath ? UI.inlineMath(t.topic_summary) : esc(t.topic_summary)}</p>` : ''}

                ${t.mistakes?.length ? `
                  <details>
                    <summary style="cursor:pointer; font-size:.86rem; font-weight:700; color:#9f1239;">
                      ⚠️ Помилки по темі (${t.mistakes_count} активних / ${t.mistakes.length} всього)
                    </summary>
                    <div class="tm-mistakes-list">
                      ${t.mistakes.map(mk => `
                        <div class="tm-mistake-row ${mk.resolved ? 'resolved' : ''}">
                          <div style="display:flex; justify-content:space-between; gap:.5rem; flex-wrap:wrap; margin-bottom:.25rem;">
                            <strong>${mk.source_type === 'ai_tutor' ? '🤖 AI-тютор' : '🧪 Селф-тест'} · ${esc(mk.module_title)}</strong>
                            <span>${mk.resolved ? '✓ Виправлено' : mk.score != null ? `Оцінка: ${mk.score}/10` : 'Помилка'}</span>
                          </div>
                          <div><strong>Питання:</strong> ${esc(mk.question_text)}</div>
                          <div><strong>Твоя відповідь:</strong> ${esc(mk.user_answer)}</div>
                          <div><strong>Очікувана відповідь${mk.source_type === 'ai_tutor' ? ' (10/10)' : ''}:</strong> ${esc(mk.expected_answer)}</div>
                          <div style="margin-top:.3rem;"><a class="text-button" href="${buildModuleUrl(courseId, t.topic_index, mk.module_id)}">Повторити модуль →</a></div>
                        </div>
                      `).join('')}
                    </div>
                  </details>
                ` : ''}
              </article>
            `;
          }).join('')}
        </div>
      </section>
    `;
  }

  // Interactive event handlers for module pages inside #workspace-main
  const main = document.querySelector('#workspace-main');
  if (main) {
    main.addEventListener('click', async (event) => {
      const watchLink = event.target.closest('[data-tm-video-watch]');
      if (watchLink) {
        const page = watchLink.closest('[data-tm-module-page]');
        if (!page) return;
        const { courseId, topicIndex, moduleId } = page.dataset;
        try {
          const res = await apiReq(
            `/api/workspace/courses/${encodeURIComponent(courseId)}/topics/${encodeURIComponent(topicIndex)}/modules/${encodeURIComponent(moduleId)}/video-watch`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                concept_id: watchLink.dataset.conceptId || '',
                concept_title: watchLink.dataset.conceptTitle || '',
                youtube_url: watchLink.getAttribute('href') || '',
              }),
            }
          );
          if (res?.learning_progress) progressCache.set(String(courseId), res.learning_progress);
          watchLink.classList.add('is-watched');
          watchLink.textContent = '✓ Переглянуто (+5 XP)';
          if (res?.message) UI.toast(res.message);
          window.dispatchEvent(new CustomEvent('hustle:rerender-module'));
        } catch {}
        return;
      }

      const optInput = event.target.closest('[data-tm-quiz-opt]');
      if (optInput) {
        const page = optInput.closest('[data-tm-module-page]');
        if (!page) return;
        const qIdx = optInput.dataset.tmQuizOpt;
        const key = `${page.dataset.courseId}:${page.dataset.topicIndex}:${page.dataset.moduleId}:${qIdx}`;
        inlineQuizSelections.set(key, Number(optInput.value));
        return;
      }

      const quizSubmitBtn = event.target.closest('[data-tm-quiz-submit]');
      if (quizSubmitBtn) {
        const page = quizSubmitBtn.closest('[data-tm-module-page]');
        const errEl = page?.querySelector('[data-tm-quiz-err]');
        if (!page) return;
        const { courseId, topicIndex, moduleId } = page.dataset;
        const activeQuizzes = page._tmActiveQuizzes || window.__hustleActiveModuleQuizzes || [];
        const answers = [];
        for (let i = 0; i < activeQuizzes.length; i++) {
          const key = `${courseId}:${topicIndex}:${moduleId}:${i}`;
          if (!inlineQuizSelections.has(key)) {
            if (errEl) errEl.textContent = 'Дай відповідь на всі питання цього підблоку.';
            return;
          }
          const q = activeQuizzes[i];
          answers.push({
            question: q.question,
            options: q.options,
            chosen_index: inlineQuizSelections.get(key),
            correct_index: q.correct_index,
            explanation: q.explanation || '',
          });
        }
        quizSubmitBtn.disabled = true;
        quizSubmitBtn.textContent = 'Перевіряємо…';
        if (errEl) errEl.textContent = '';
        try {
          const res = await apiReq(
            `/api/workspace/courses/${encodeURIComponent(courseId)}/topics/${encodeURIComponent(topicIndex)}/modules/${encodeURIComponent(moduleId)}/quiz-submit`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ answers }),
            }
          );
          inlineQuizResults.set(`${courseId}:${topicIndex}:${moduleId}`, res);
          if (res?.learning_progress) progressCache.set(String(courseId), res.learning_progress);
          window.dispatchEvent(new CustomEvent('hustle:rerender-module'));
        } catch (err) {
          if (errEl) errEl.textContent = err.message;
          quizSubmitBtn.disabled = false;
          quizSubmitBtn.textContent = 'Перевірити селф-тести →';
        }
        return;
      }

      const voiceBtn = event.target.closest('[data-tm-tutor-voice]');
      if (voiceBtn && SpeechRec) {
        const form = voiceBtn.closest('[data-tm-tutor-form]');
        const textarea = form?.elements?.answer_text;
        if (!textarea) return;
        const rec = new SpeechRec();
        rec.lang = 'uk-UA';
        rec.interimResults = false;
        voiceBtn.disabled = true;
        voiceBtn.textContent = '🎙️ Слухаю…';
        rec.onresult = (e) => {
          const spoken = e.results?.[0]?.[0]?.transcript || '';
          if (spoken) textarea.value = (textarea.value ? textarea.value + ' ' : '') + spoken;
        };
        rec.onend = () => {
          voiceBtn.disabled = false;
          voiceBtn.textContent = '🎙️ Надиктувати голосом';
        };
        rec.onerror = () => {
          voiceBtn.disabled = false;
          voiceBtn.textContent = '🎙️ Надиктувати голосом';
        };
        rec.start();
      }
    });

    main.addEventListener('submit', async (event) => {
      const form = event.target.closest('[data-tm-tutor-form]');
      if (!form) return;
      event.preventDefault();
      const page = form.closest('[data-tm-module-page]');
      if (!page) return;
      const { courseId, topicIndex, moduleId } = page.dataset;
      const answerText = form.elements.answer_text?.value?.trim() || '';
      const errEl = form.querySelector('[data-tm-tutor-err]');
      const btn = form.querySelector('[data-tm-tutor-submit]');
      if (!answerText) {
        if (errEl) errEl.textContent = 'Напиши або надиктуй свою відповідь.';
        return;
      }
      if (errEl) errEl.textContent = '';
      if (btn) { btn.disabled = true; btn.textContent = 'AI перевіряє…'; }
      let progressSlot = form.querySelector('[data-tm-tutor-progress]');
      if (!progressSlot) {
        progressSlot = document.createElement('div');
        progressSlot.setAttribute('data-tm-tutor-progress', '');
        form.append(progressSlot);
      }
      const tutorTracker = window.HustleProgress?.mount(progressSlot, {
        title: 'AI-тютор перевіряє відповідь…',
        stages: ['Читаємо твою відповідь', 'Звіряємо з конспектом модуля', 'Формуємо відгук і підказки'],
        expectedSec: 9,
        compact: true,
      });
      try {
        const res = await apiReq(
          `/api/workspace/courses/${encodeURIComponent(courseId)}/topics/${encodeURIComponent(topicIndex)}/modules/${encodeURIComponent(moduleId)}/tutor-check`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answer_text: answerText }),
          }
        );
        tutorTracker?.stop({remove: true});
        inlineTutorResults.set(`${courseId}:${topicIndex}:${moduleId}`, res);
        if (res?.learning_progress) progressCache.set(String(courseId), res.learning_progress);
        if (form.elements.answer_text) form.elements.answer_text.value = '';
        window.dispatchEvent(new CustomEvent('hustle:rerender-module'));
      } catch (err) {
        tutorTracker?.stop({remove: true});
        if (errEl) errEl.textContent = err.message;
        if (btn) { btn.disabled = false; btn.textContent = 'Перевірити відповідь у AI-тютора →'; }
      }
    });
  }

  function getCachedProgress(courseId) {
    return progressCache.get(String(courseId)) || null;
  }

  async function hydrate(main, bundle) {
    if (!main || !bundle?.course?.course_id) return;
    const courseId = bundle.course.course_id;
    const dashHost = main.querySelector('[data-course-learning-progress]');
    const hasModuleView = Boolean(main.querySelector('[data-tm-summary], [data-tm-module-page]'));
    if (!dashHost && !hasModuleView) return;
    const wasCached = progressCache.has(String(courseId));
    try {
      const progress = await fetchProgress(courseId);
      if (dashHost && main.contains(dashHost)) {
        dashHost.innerHTML = renderDashboardProgress(progress, courseId);
        UI.enhance?.(dashHost);
      }
      if (hasModuleView && !wasCached && main.querySelector('[data-tm-summary], [data-tm-module-page]')) {
        window.dispatchEvent(new CustomEvent('hustle:rerender-module'));
      }
    } catch {
      // Real API errors remain non-blocking unless explicit action taken.
    }
  }

  window.HustleModules = {
    moduleIdFor,
    topicIndexFor,
    buildTopicUrl,
    buildModuleUrl,
    getCachedProgress,
    fetchProgress,
    hydrate,
    findTopicProgress,
    findModuleProgress,
    quizzesForModule,
    renderSummaryCard,
    renderModuleCards,
    renderDedicatedModulePage,
    renderDashboardProgress,
    clearCache: (courseId) => progressCache.delete(String(courseId)),
  };
})();
