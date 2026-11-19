(() => {
  const H = window.Hustle;
  if (!H.account?.owner) return;

  const { escape: esc, icon } = H;
  const storageKey = `hustle.learning-rewards.v1:${H.account.owner}`;
  const rates = { cards: { xp: 12, points: 8 }, quiz: { xp: 20, points: 12 }, deadline: { xp: 15, points: 10 } };
  const levels = [0, 30, 75, 125, 200];
  const shop = [
    { id: 'avatar-search', slot: 'avatar', name: 'Детектив', pose: 'search', tone: 'sage', price: 12, level: 1 },
    { id: 'avatar-study', slot: 'avatar', name: 'Книжковий ослик', pose: 'study', tone: 'lilac', price: 16, level: 1 },
    { id: 'avatar-idea', slot: 'avatar', name: 'Є ідея!', pose: 'quiz-correction', tone: 'butter', price: 24, level: 1 },
    { id: 'avatar-deadline', slot: 'avatar', name: 'Дедлайнер', pose: 'deadline', tone: 'peach', price: 30, level: 2 },
    { id: 'avatar-rest', slot: 'avatar', name: 'На чілі', pose: 'review-due', tone: 'blue', price: 42, level: 2 },
    { id: 'avatar-champion', slot: 'avatar', name: 'Чемпіон', pose: 'complete', tone: 'rose', collection: true },
  ];
  const previousRewards = [
    { id: 'lilac', slot: 'cover', name: 'Бузкова обкладинка', detail: 'Лавандове тло маршруту.', price: 20, level: 1 },
    { id: 'honey', slot: 'frame', name: 'Медова рамка', detail: 'Золотий кант навколо аватара.', price: 28, level: 2 },
    { id: 'notebook', slot: 'cover', name: 'Зошит у клітинку', detail: 'Паперова обкладинка маршруту.', price: 46, level: 3 },
    { id: 'library', slot: 'cover', name: 'Тепла бібліотека', detail: 'Обкладинка за повну колекцію.', collection: true },
  ];
  const inventory = [...shop, ...previousRewards];
  const albumAvatar = shop.find((item) => item.collection);
  const previousDonkeys = [
    { id: 'deadline', name: 'Дедлайнер', pose: 'deadline', hint: 'Біля списку дедлайнів.' },
    { id: 'notes', name: 'Лектор', pose: 'study', hint: 'Коли відкриєш конспект теми.' },
    { id: 'search', name: 'Шукач', pose: 'search', hint: 'Там, де зібрано теми й матеріали курсу.' },
    { id: 'quiz', name: 'Квізер', pose: 'complete', hint: 'Після успішної самоперевірки.' },
    { id: 'quiz-start', name: 'Ведучий квізу', pose: 'quiz-start', hint: 'Перед початком мініквізу.' },
    { id: 'quiz-correction', name: 'Підказувач', pose: 'quiz-correction', hint: 'Поруч із поясненням відповіді в квізі.' },
    { id: 'flashcard-flip', name: 'Карткар', pose: 'flashcard-flip', hint: 'Коли відкриєш відповідь на першій картці.' },
    { id: 'review-due', name: 'Повторювач', pose: 'review-due', hint: 'На початку серії карток за розкладом.' },
    { id: 'oral-practice', name: 'Оратор', pose: 'oral-practice', hint: 'У підготовці до усного захисту.' },
  ];
  const sceneDonkeys = [
    { id: 'trail-map', name: 'Картограф', pose: 'trail-map', hint: 'Хто проклав твій навчальний маршрут?' },
    { id: 'paper-plane', name: 'Пілот', pose: 'paper-plane', hint: 'Приземлився десь під списком предметів.' },
    { id: 'book-fort', name: 'Книжковий вартовий', pose: 'book-fort', hint: 'Визирає зі стосу матеріалів курсу.' },
    { id: 'card-trick', name: 'Фокусник', pose: 'card-trick', hint: 'Має козир у колодах Anki.' },
    { id: 'lucky-die', name: 'Кубик удачі', pose: 'lucky-die', hint: 'Докотився до кінця списку тем у практиці курсу.' },
    { id: 'headphones', name: 'Тихий режим', pose: 'headphones', hint: 'Знайшов тишу біля таймера Pomodoro.' },
    { id: 'pencil-race', name: 'Олівцевий гонщик', pose: 'pencil-race', hint: 'Промчав повз дні й зупинився під календарем місяця.' },
    { id: 'nap-notes', name: 'Дрімко', pose: 'nap-notes', hint: 'Дрімає там, де налаштовуєш час навчання на день.' },
  ];
  const donkeys = [...previousDonkeys, ...sceneDonkeys];
  const legacyCollection = ['deadline', 'notes', 'search', 'quiz'];
  const albumVersion = 3;

  let legacyXP = () => 0;
  let ankiQueue = null;
  let ankiReviewedToday = 0;
  const routes = new WeakMap();
  const key = (kind, course, topic) => `${kind}:${course}:${topic}`;
  const mascot = (pose, loading = 'eager') => `<img src="/prototype/assets/mascot/${pose}.webp" width="384" height="384" alt="" decoding="async" loading="${loading}">`;
  const activeAvatar = (data = read()) => shop.find(item => item.id === data.equipped.avatar && owns(item, data));
  const portrait = (item) => `<span class="reward-portrait" data-reward-tone="${item.tone}" aria-hidden="true">${mascot(item.pose)}</span>`;
  const found = (data) => donkeys.filter((donkey) => data.found[donkey.id]).length;
  const owns = (item, data) => item.collection ? Boolean(data.unlocked[item.id] || found(data) === donkeys.length) : Object.hasOwn(data.bought, item.id);

  function read() {
    let data;
    try { data = JSON.parse(localStorage.getItem(storageKey)); } catch {}
    const map = (name) => data?.[name] && typeof data[name] === 'object' && !Array.isArray(data[name]) ? data[name] : {};
    const found = map('found');
    const unlocked = map('unlocked');
    // Credit the original four-sticker album for existing owners when its size changes.
    if (!data?.albumVersion && legacyCollection.every((id) => found[id])) unlocked.library = true;
    if ((data?.albumVersion ?? 0) < albumVersion && previousDonkeys.every(({ id }) => found[id])) {
      unlocked.library = true;
      unlocked[albumAvatar.id] = true;
    }
    return { practice: map('practice'), bought: map('bought'), equipped: map('equipped'), found, unlocked, albumVersion,
      targets: map('targets'), recent: data?.recent || null, recentDeadline: data?.recentDeadline || '' };
  }

  async function change(action) {
    const apply = () => {
      const data = read();
      const result = action(data);
      if (result == null) return result;
      localStorage.setItem(storageKey, JSON.stringify(data));
      return result;
    };
    const result = await (navigator.locks?.request ? navigator.locks.request(storageKey, apply) : apply());
    refresh();
    return result;
  }

  function totals(data = read(), course) {
    const entries = Object.values(data.practice);
    const xp = (Number(legacyXP(course)) || 0) + entries.reduce((sum, entry) =>
      sum + (!course || entry.course === String(course) ? Number(entry.xp) || 0 : 0), 0);
    const balance = entries.reduce((sum, entry) => sum + (Number(entry.points) || 0), 0)
      - inventory.reduce((sum, item) => sum + (Number(data.bought[item.id]) || 0), 0);
    const index = levels.findLastIndex((level) => xp >= level);
    return { xp, balance, level: index + 1, floor: levels[index], next: levels[index + 1] };
  }

  function credit(data, kind, course, topic) {
    const id = key(kind, course, topic);
    if (Object.hasOwn(data.practice, id)) return null;
    const before = totals(data).level;
    const award = { ...rates[kind], course: String(course) };
    data.practice[id] = award;
    if (kind === 'deadline') data.recentDeadline = id;
    else data.recent = { course: String(course), topic: String(topic) };
    const after = totals(data).level;
    return { ...award, level: after > before ? after : null };
  }

  async function earn(kind, course, topic) {
    if (!['cards', 'quiz'].includes(kind) || !/^\d+$/.test(String(course)) || !/^\d+$/.test(String(topic))) return null;
    return change((data) => credit(data, kind, course, topic));
  }

  function deadlineKey(task) {
    const match = /^(\d+):assignment:(\d+)$/.exec(task?.id || '');
    return match && { id: key('deadline', match[1], match[2]), course: match[1], assignment: match[2] };
  }

  function nextDeadline(tasks, data) {
    return tasks.find((task) => {
      const target = deadlineKey(task);
      return target && !task.done && !data.practice[target.id];
    });
  }

  async function earnDeadline(task) {
    const target = deadlineKey(task);
    if (!target || !task.done) return;
    try {
      const award = await change((data) => credit(data, 'deadline', target.course, target.assignment));
      if (award) announce(awardText(award));
    } catch {
      announce('Не вдалося зберегти нагороду за дедлайн.');
    }
  }

  async function trackDeadlines(tasks) {
    const data = read();
    const pending = deadlineKey(nextDeadline(tasks, data));
    const confirmed = tasks.filter((task) => {
      const target = deadlineKey(task);
      return task.submitted && target && data.targets[target.id] && !data.practice[target.id];
    });
    for (const task of confirmed) await earnDeadline(task);
    if (!pending || data.targets[pending.id]) return;
    try {
      await change((current) => {
        if (current.targets[pending.id]) return null;
        current.targets[pending.id] = true;
        return true;
      });
    } catch {
      announce('Не вдалося зберегти навчальний маршрут.');
    }
  }

  function awardText(award) {
    if (!award) return '';
    return `+${award.xp} XP · +${award.points} поінтів${award.level ? ` · Рівень ${award.level}` : ''}`;
  }

  function availability(item, data, progress) {
    if (owns(item, data)) return '';
    if (item.collection) return UI.countLabel(donkeys.length, 'ослик', 'ослики', 'осликів');
    if (progress.level < item.level) return `Від рівня ${item.level}`;
    const missing = item.price - progress.balance;
    return missing > 0 ? `Ще ${pointLabel(missing)}` : '';
  }

  function buy(id) {
    return change((data) => {
      const item = shop.find((entry) => entry.id === id);
      if (!item || item.collection || owns(item, data) || availability(item, data, totals(data))) return null;
      data.bought[id] = item.price;
      data.equipped[item.slot] = id;
      return `Аватарку «${item.name}» встановлено.`;
    });
  }

  function wear(id) {
    return change((data) => {
      const item = inventory.find((entry) => entry.id === id);
      if (!item || !owns(item, data)) return null;
      const equipped = data.equipped[item.slot] === id;
      data.equipped[item.slot] = equipped ? '' : id;
      if (item.slot === 'avatar') return equipped ? 'Стандартну аватарку відновлено.' : `Аватарку «${item.name}» встановлено.`;
      return equipped ? `Знято «${item.name}».` : `Застосовано «${item.name}».`;
    });
  }

  function marker(id, style = '') {
    const donkey = donkeys.find((entry) => entry.id === id);
    if (!donkey || read().found[id]) return '';
    const scene = sceneDonkeys.includes(donkey) ? 'reward-donkey--scene' : '';
    return `<button type="button" class="reward-donkey ${scene} ${style}" data-reward-find="${id}" aria-label="Знайти ослика «${donkey.name}»">${mascot(donkey.pose)}<span aria-hidden="true">✦</span></button>`;
  }

  async function find(button) {
    if (button.disabled || button.hasAttribute('aria-disabled')) return;
    const scene = button.classList.contains('reward-donkey--scene');
    if (scene) button.setAttribute('aria-disabled', 'true');
    else button.disabled = true;
    try {
      const id = button.dataset.rewardFind;
      const donkey = donkeys.find((entry) => entry.id === id);
      const foundMessage = await change((data) => {
        if (!donkey || data.found[id]) return null;
        data.found[id] = true;
        const count = found(data);
        if (count === donkeys.length) {
          const avatarUnlocked = data.unlocked[albumAvatar.id];
          data.unlocked.library = true;
          data.unlocked[albumAvatar.id] = true;
          return avatarUnlocked ? 'Колекцію зібрано!' : `Колекцію зібрано. Аватарку «${albumAvatar.name}» відкрито.`;
        }
        return `«${donkey.name}» у колекції · ${count}/${donkeys.length}`;
      });
      const message = foundMessage || 'Ослик уже в колекції.';
      announce(message);
      if (!button.isConnected) {
        document.querySelector('[data-rewards-panel] a[href="#rewards/collection"]')?.focus();
        return;
      }
      if (scene) {
        button.setAttribute('aria-label', message);
        button.toggleAttribute('data-reward-collected', true);
        button.querySelector('span').textContent = '✓';
        return;
      }
      const status = button.ownerDocument.createElement('span');
      status.className = 'reward-find-note';
      status.role = 'status';
      status.tabIndex = -1;
      status.textContent = message;
      button.after(status);
      status.focus({ preventScroll: true });
    } catch {
      if (scene) {
        button.removeAttribute('aria-disabled');
        announce('Не вдалося зберегти знахідку. Спробуй іще раз.');
        return;
      }
      button.disabled = false;
      const note = button.ownerDocument.createElement('p');
      note.className = 'field-error';
      note.role = 'alert';
      note.textContent = 'Не вдалося зберегти знахідку. Спробуй іще раз.';
      button.after(note);
    }
  }

  function progressMarkup(data) {
    const p = totals(data);
    const next = shop.find((item) => !item.collection && !owns(item, data));
    const value = p.next ? p.xp - p.floor : 1;
    const max = p.next ? p.next - p.floor : 1;
    const scout = marker('trail-map', 'reward-donkey--route') || `<span class="reward-donkey-art reward-donkey--route" aria-hidden="true">${mascot('trail-map')}</span>`;
    return `<div class="reward-level-head"><div><span class="reward-level-name">Рівень ${p.level}</span><strong>${p.xp} XP</strong></div>${scout}</div>
      <progress class="reward-meter" aria-label="Досвід до наступного рівня" value="${value}" max="${max}"></progress>
      <p class="reward-level-copy">${p.next ? `Ще ${p.next - p.xp} XP до рівня ${p.level + 1}` : 'Усі рівні відкрито'}</p>
      ${next ? `<a class="reward-panel-row" href="#rewards">${portrait(next)}<span><strong>Аватарка «${next.name}»</strong><small>${availability(next, data, p) || 'Можна купити'}</small></span>${icon('arrow')}</a>` : ''}
      <a class="reward-panel-row" href="#rewards/collection"><span class="reward-swatch reward-coin" aria-hidden="true">✦</span><span><strong>Колекція осликів</strong><small>${found(data)} з ${donkeys.length} знайдено</small></span>${icon('arrow')}</a>`;
  }

  function topicSteps(topic, course, data) {
    return [
      { kind: 'cards', route: 'cards', count: topic.cards_count },
      { kind: 'quiz', route: 'quizzes', count: topic.question_count },
    ].filter((step) => step.count > 0).map((step) => ({ ...step, done: Boolean(data.practice[key(step.kind, course, topic.topic_index)]) }));
  }

  const pointLabel = (points) => UI.countLabel(points, 'поінт', 'поінти', 'поінтів');

  function questRow({ id, title, detail, symbol, href, reward, done }) {
    const body = `<span class="reward-route-node" aria-hidden="true">${icon(done ? 'check' : symbol)}</span>
      <span class="reward-quest-copy"><strong>${title}</strong><small>${esc(detail)}</small></span>
      ${reward ? `<span class="reward-quest-payout"><strong>+${pointLabel(reward.points)}</strong><small>+${reward.xp} XP</small></span>` : done ? '<span class="reward-quest-done">Зараховано</span>' : ''}
      ${href ? `<span class="reward-quest-arrow" aria-hidden="true">${icon('arrow')}</span>` : ''}`;
    return `<li class="reward-quest" data-reward-quest="${id}" ${done ? 'data-reward-done' : ''}>
      ${href ? `<a href="${esc(href)}">${body}</a>` : `<div>${body}</div>`}</li>`;
  }

  function ankiQuest(data) {
    const newTopics = new Set();
    for (const card of ankiQueue || []) {
      const course = card.courseId ?? card.course_id;
      const topic = card.topicIndex ?? card.topic_index;
      if (!(Number(course) > 0) || !/^\d+$/.test(String(topic))) continue;
      const id = key('cards', course, topic);
      if (!data.practice[id]) newTopics.add(id);
    }
    const count = ankiQueue?.length || 0;
    const done = !count && ankiReviewedToday > 0;
    return questRow({ id: 'anki', title: 'Повтори картки Anki', symbol: 'courses',
      href: count ? '#anki/study' : '#anki',
      detail: ankiQueue === null ? 'Колоди й повторення' : count ? UI.countLabel(count, 'картка у черзі', 'картки у черзі', 'карток у черзі') : done ? 'Чергу на сьогодні повторено' : 'Черга на сьогодні порожня',
      reward: newTopics.size ? { points: rates.cards.points * newTopics.size, xp: rates.cards.xp * newTopics.size } : null, done });
  }

  function quizQuest({ course, topics = [], error = false }, data) {
    const quiz = topics.find((topic) => topic.question_count > 0 && !data.practice[key('quiz', course, topic.topic_index)]);
    const previousQuiz = topics.some((topic) => topic.question_count > 0 && data.practice[key('quiz', course, topic.topic_index)]);
    return questRow({ id: 'quiz', title: 'Пройди квіз', symbol: 'practice',
      href: course ? UI.courseLink(course, 'quizzes', quiz?.topic_index) : '',
      detail: quiz ? `${UI.courseName(quiz.title)} · від ⅔ правильних відповідей` : error ? 'Не вдалося завантажити квізи' : previousQuiz ? 'Самоперевірку завершено' : course ? 'Квізи за темами' : 'Спочатку додай предмет',
      reward: quiz ? rates.quiz : null, done: !quiz && previousQuiz });
  }

  function readingQuest(bundle, course) {
    const nodes = bundle.course_map?.nodes || [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const excluded = ['info', 'resources', 'archive', 'assessment'];
    const readable = nodes.filter(node => {
      if (!node.learnable || !(node.book_sections?.length || node.materials?.some(material =>
        ['lesson', 'book', 'page', 'resource'].includes(material.modname) &&
        ![false, 0, '0'].includes(material.uservisible) && ![false, 0, '0'].includes(material.visible)))) return false;
      for (let parent = byId.get(node.parent_id); parent; parent = byId.get(parent.parent_id)) {
        if (excluded.includes(parent.kind)) return false;
      }
      return true;
    });
    let recent;
    try { recent = JSON.parse(sessionStorage.getItem('hustle:course-reading:' + H.account.owner))?.[course]; } catch {}
    const node = readable.find(item => item.id === recent?.nodeId) ||
      readable.find(item => recent?.topicIndex != null && String(item.topic_index) === String(recent.topicIndex)) ||
      readable.find(item => item.book_sections?.length) || readable[0];
    if (!node) return null;
    const path = UI.courseLink(course, 'reading', node.topic_index ?? undefined);
    return { id: 'reading', symbol: 'bookmark', title: node.book_sections?.length ? 'Читати конспект' : 'Читати матеріали',
      detail: UI.courseName(node.title), href: path + (path.includes('?') ? '&' : '?') + 'node=' + encodeURIComponent(node.id) };
  }

  function studyActions(model, data) {
    if (!model.course) return '';
    const reading = model.reading || { id: 'reading', symbol: 'bookmark', title: 'Відкрити теми',
      detail: H.workspace.courses.find(course => course.id === model.course)?.name || '', href: UI.courseLink(model.course, 'topics') };
    return `<ul class="reward-quests" aria-label="До навчання">${questRow(reading)}${quizQuest(model, data)}</ul>`;
  }

  function routeMarkup({ course, topics = [], tasks = [], error = false }, data) {
    const pending = nextDeadline(tasks, data);
    const closed = !pending && tasks.some((task) => task.done && deadlineKey(task)?.id === data.recentDeadline);
    const current = topics.find((topic) => topicSteps(topic, course, data).some((step) => !step.done));
    const next = current && topics[topics.indexOf(current) + 1];
    const nextStep = next && topicSteps(next, course, data)[0];
    const cards = current?.cards_count > 0 && !data.practice[key('cards', course, current.topic_index)];
    const queueHasTopic = cards && ankiQueue?.some((card) => String(card.courseId ?? card.course_id) === course &&
      String(card.topicIndex ?? card.topic_index) === String(current.topic_index));
    const alternate = cards && !queueHasTopic ? questRow({ id: 'cards', title: 'Повтори картки теми', symbol: 'courses',
      href: UI.courseLink(course, 'cards', current.topic_index), detail: UI.courseName(current.title), reward: rates.cards }) : '';

    return `<h3>Виконай завдання й отримай поінти</h3><ul class="reward-quests">
      ${questRow({ id: 'deadline', title: 'Закрий дедлайн', symbol: 'calendar', href: '#deadlines',
        detail: pending ? 'Познач найближче завдання виконаним' : closed ? 'Дедлайн виконано' : 'Відкритих дедлайнів немає',
        reward: pending ? rates.deadline : null, done: closed })}
      ${quizQuest({ course, topics, error }, data)}
      ${ankiQuest(data)}${alternate}</ul>
      ${nextStep ? `<a class="reward-next-topic" href="${UI.courseLink(course, nextStep.route, next.topic_index)}">Наступна тема <strong>${esc(UI.courseName(next.title))}</strong>${icon('arrow')}</a>` : ''}`;
  }

  async function loadRoute(host) {
    const model = routes.get(host);
    const { course } = model;
    const url = `/api/workspace/courses/${encodeURIComponent(course)}`;
    if (model.overview) {
      const [bundle, quizzes] = await Promise.allSettled([UI.api(url), UI.api(url + '/quizzes')]);
      if (!host.isConnected) return;
      if (bundle.status === 'fulfilled') model.reading = readingQuest(bundle.value, course);
      model.topics = quizzes.status === 'fulfilled' ? quizzes.value.topics || [] : [];
      model.error = quizzes.status === 'rejected';
      drawQuests(host, read());
      return;
    }
    try {
      const results = await Promise.allSettled(['flashcards', 'quizzes'].map((part) => UI.api(`${url}/${part}`)));
      if (!host.isConnected) return;
      if (results.every((result) => result.status === 'rejected')) throw new Error('Course practice is unavailable');
      const index = new Map();
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const topic of result.value.topics || []) index.set(topic.topic_index, { ...index.get(topic.topic_index), ...topic });
      }
      model.topics = [...index.values()].filter((topic) => topic.cards_count > 0 || topic.question_count > 0);
    } catch {
      model.error = true;
    }
    if (host.isConnected) drawQuests(host, read());
  }

  function renderShop(hash, showOwned = false) {
    const data = read();
    const p = totals(data);
    const album = hash === 'rewards/collection';
    const previous = previousRewards.filter(item => owns(item, data));
    const content = album
      ? `<div class="reward-album-summary"><strong>${found(data)}/${donkeys.length} знайдено</strong><span>${owns(albumAvatar, data) ? `Аватарку «${albumAvatar.name}» відкрито.` : `Повна колекція відкриває аватарку «${albumAvatar.name}».`}</span>${owns(albumAvatar, data) ? '<a class="text-button" href="#rewards">До аватарок →</a>' : ''}<p>Знайдеш ослика в навчальному просторі — натисни на нього.</p></div>
        <div class="reward-grid reward-album-grid">${donkeys.map((donkey) => `<article class="reward-item" ${data.found[donkey.id] ? 'data-album-found' : ''}><span class="reward-album-art" aria-hidden="true">${mascot(donkey.pose, 'lazy')}</span><div><h2>${data.found[donkey.id] ? donkey.name : 'Ослик сховався'}</h2><p>${data.found[donkey.id] ? 'У колекції' : donkey.hint}</p></div></article>`).join('')}</div>`
      : `<div class="reward-grid reward-product-grid">${shop.map((item) => {
        const owned = owns(item, data);
        const equipped = data.equipped[item.slot] === item.id;
        const lock = availability(item, data, p);
        const action = owned ? `<button class="secondary" data-reward-wear="${item.id}">${equipped ? 'Скинути' : 'Встановити'}</button>`
          : item.collection ? '<a class="secondary" href="#rewards/collection">До колекції</a>'
          : `<button class="primary" data-reward-buy="${item.id}" ${lock ? 'disabled' : ''}>${lock || 'Купити'}</button>`;
        const label = equipped ? 'У профілі' : owned ? 'Придбано' : item.collection ? lock : pointLabel(item.price);
        return `<article class="reward-item reward-product" ${equipped ? 'data-reward-equipped' : ''}>
          <div class="reward-product-image" data-reward-tone="${item.tone}">${portrait(item)}</div>
          <div class="reward-product-copy"><h2>${item.name}</h2><div class="reward-item-actions"><strong>${label}</strong>${action}</div></div>
        </article>`;
      }).join('')}</div>${previous.length ? `<details class="reward-owned" ${showOwned ? 'open' : ''}><summary>Раніше отримане оформлення</summary><div class="reward-grid">${previous.map(item => `<article class="reward-item"><span class="reward-swatch" data-reward-item="${item.id}" aria-hidden="true">${icon(item.slot === 'frame' ? 'check' : 'files')}</span><div><h2>${item.name}</h2><p>${item.detail}</p></div><button class="secondary" data-reward-wear="${item.id}">${data.equipped[item.slot] === item.id ? 'Зняти' : 'Застосувати'}</button></article>`).join('')}</div></details>` : ''}`;
    return `<section class="reward-shop"><header class="page-heading dashboard-heading"><h1 tabindex="-1">${album ? 'Колекція осликів' : 'Нагороди'}</h1></header><nav class="reward-tabs" aria-label="Нагороди"><a class="secondary" href="#rewards" ${album ? '' : 'aria-current="page"'}>Аватарки</a><a class="secondary" href="#rewards/collection" ${album ? 'aria-current="page"' : ''}>Ослячий альбом</a></nav>${content}</section>`;
  }

  const balance = document.createElement('a');
  balance.className = 'reward-wallet';
  balance.href = '#rewards';
  document.querySelector('.topbar-account').before(balance);

  function drawQuests(panel, data) {
    const model = routes.get(panel);
    const host = panel.querySelector('[data-reward-quests]');
    if (!model || !host) return;
    const focused = host.contains(document.activeElement) && document.activeElement.closest('[data-reward-quest]')?.dataset.rewardQuest;
    host.innerHTML = model.overview ? studyActions(model, data) : routeMarkup(model, data);
    if (focused) host.querySelector(`[data-reward-quest="${focused}"] a`)?.focus({ preventScroll: true });
  }

  function refresh() {
    const data = read();
    const p = totals(data);
    balance.innerHTML = `<i aria-hidden="true"></i><strong>${p.balance}</strong><span>поінтів</span>`;
    balance.setAttribute('aria-label', `Нагороди · ${p.balance} поінтів`);
    document.body.dataset.rewardCover = data.equipped.cover || '';
    document.body.dataset.rewardFrame = data.equipped.frame || '';
    H.refreshProfile?.();
    document.querySelectorAll('[data-rewards-panel]').forEach((panel) => {
      panel.querySelector('[data-reward-progress]').innerHTML = progressMarkup(data);
      drawQuests(panel, data);
    });
  }

  const announcement = document.createElement('div');
  announcement.className = 'reward-toast';
  announcement.role = 'status';
  announcement.hidden = true;
  document.body.append(announcement);
  let toastTimer;
  function announce(message) {
    clearTimeout(toastTimer);
    announcement.textContent = message;
    announcement.hidden = false;
    toastTimer = setTimeout(() => { announcement.hidden = true; }, 4000);
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-reward-find], [data-reward-buy], [data-reward-wear]');
    if (!button || button.disabled) return;
    if (button.dataset.rewardFind) { await find(button); return; }
    const id = button.dataset.rewardBuy || button.dataset.rewardWear;
    button.disabled = true;
    try {
      const message = await (button.dataset.rewardBuy ? buy(id) : wear(id));
      announce(message || 'Нагорода поки недоступна.');
      if (button.isConnected) {
        const main = document.querySelector('#workspace-main');
        main.innerHTML = renderShop(location.hash.slice(1), main.querySelector('.reward-owned')?.open);
        main.querySelector(`[data-reward-wear="${id}"], [data-reward-buy="${id}"]`)?.focus();
      }
    } catch {
      button.disabled = false;
      announce('Не вдалося зберегти нагороду. Спробуй іще раз.');
    }
  });

  window.addEventListener('storage', (event) => { if (event.key === storageKey) refresh(); });
  window.HustleRewards = {
    earn, earnDeadline, awardText, marker, find, totals, renderShop, refresh, activeAvatar,
    setLegacy(getter) { legacyXP = getter; refresh(); },
    setAnkiQueue(queue, reviewedToday) {
      ankiQueue = queue;
      ankiReviewedToday = reviewedToday;
      const data = read();
      document.querySelectorAll('[data-rewards-panel]:not([data-reward-overview])').forEach((panel) => drawQuests(panel, data));
    },
    panel(course, activity = '') {
      return `<section class="reward-panel reward-journey" data-rewards-panel${activity ? ' data-reward-overview' : ''} data-reward-course="${esc(course || '')}" aria-labelledby="reward-journey-title">
        <div class="reward-journey-progress"><h2 id="reward-journey-title">Навчальний маршрут</h2><div data-reward-progress></div></div>
        ${activity ? `<div class="reward-journey-content">${activity}<div class="reward-journey-study" data-reward-quests></div></div>` : '<div class="reward-journey-actions" data-reward-quests></div>'}
      </section>`;
    },
    preferred(courses, fallback) { const id = read().recent?.course; return courses.some((course) => course.id === id) ? id : fallback; },
    mount(root, tasks = []) {
      const panel = root.querySelector('[data-rewards-panel]');
      if (panel && !routes.has(panel)) {
        const course = panel.dataset.rewardCourse;
        routes.set(panel, { course, tasks, overview: panel.hasAttribute('data-reward-overview') });
        if (course && panel.querySelector('[data-reward-quests]')) loadRoute(panel);
        trackDeadlines(tasks);
      }
      refresh();
    },
  };
  refresh();
})();
