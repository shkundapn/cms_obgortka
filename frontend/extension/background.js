importScripts('hustle-config.js', 'hustle-bridge-worker.js');
const DEFAULT_PORTAL_URL = HUSTLE_CONFIG.defaultPortal;
const ALLOWED_LOCAL_PORTAL_ORIGINS = new Set([
  'http://127.0.0.1:8000',
  'http://localhost:8000',
]);
const SUPPORTED_MOODLE_HOSTS = [
  'learn.ucu.edu.ua',
  'e-learning.lnu.edu.ua',
  'vns.lpnu.ua',
  'dl.nure.ua',
  'do.ipo.kpi.ua',
  'moodle.vntu.edu.ua',
  'school.moodledemo.net',
];
const COOKIE_PAIR_COOLDOWN_MS = 10 * 60 * 1000;
const inFlightPairs = new Map();
const lastTabCheckAt = new Map();

function sanitizePortalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(rawUrl.trim());
    if (!HUSTLE_CONFIG.portalOrigins.includes(u.origin) || u.username || u.password) return null;
    const origin = `${u.protocol}//${u.host}`.toLowerCase();
    if (ALLOWED_LOCAL_PORTAL_ORIGINS.has(origin) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return origin;
    }
    // Remote portals must use HTTPS (never leak MoodleSession over plaintext HTTP)
    if (u.protocol === 'https:' && !u.username && !u.password) {
      return origin;
    }
  } catch (e) {}
  return null;
}

function extractMoodleOrigin(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (SUPPORTED_MOODLE_HOSTS.includes(host) && u.protocol === 'https:') {
      return `https://${host}`;
    }
  } catch (e) {}
  return null;
}

async function hashCookieValue(cookieValue) {
  const bytes = new TextEncoder().encode(String(cookieValue || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function pairMoodleCookie(moodleOrigin, cookieValue, portalUrlOverride, force = false) {
  if (!moodleOrigin || !cookieValue) return { success: false, skipped: true };
  const portalUrl = await getPortalUrl(portalUrlOverride);
  if (!(await approvedConnection(moodleOrigin, portalUrl))) return {success:false, error:"Спершу підключи Moodle на сайті Hustle."};
  const cookieHash = await hashCookieValue(cookieValue);
  const dedupKey = `${portalUrl}|${moodleOrigin}|${cookieHash}`;

  if (inFlightPairs.has(dedupKey)) {
    return inFlightPairs.get(dedupKey);
  }

  const runPromise = (async () => {
    const cacheStore = await chrome.storage.local.get(['pairedCookieCache']);
    const existingMap = cacheStore.pairedCookieCache || {};
    const cache = existingMap[`${portalUrl}|${moodleOrigin}`];
    const cacheFresh =
      cache &&
      cache.cookieHash === cookieHash &&
      Date.now() - (cache.pairedAt || 0) < COOKIE_PAIR_COOLDOWN_MS;

    // Even inside cooldown, allow explicit SYNC_COURSE to upgrade linkage if google_linked was false
    if (!force && cacheFresh && cache.google_linked) {
      return { success: true, cached: true, moodleOrigin };
    }
    if (!force && cacheFresh && cache._autoAttempted) {
      return { success: true, cached: true, moodleOrigin };
    }

    try {
      let res = await fetch(`${portalUrl}/api/auth/extension-pair`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moodle_url: moodleOrigin, cookie: cookieValue }),
      });
      if (res.status === 502) {
        const myRes = await fetch(`${moodleOrigin}/my/`, { credentials: 'include' });
        const myHtml = await myRes.text().catch(() => '');
        const isLogin = (myRes.url && myRes.url.includes('/login/')) ||
          (myHtml.includes('name="username"') && myHtml.includes('name="password"'));
        if (!myRes.ok || isLogin || !myHtml) {
          return { success: false, status: 401, needsLogin: true, error: 'Увійди в Moodle у браузері.' };
        }
        res = await fetch(`${portalUrl}/api/auth/extension-pair`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            moodle_url: moodleOrigin,
            cookie: cookieValue,
            browser_my_html: myHtml.slice(0, 500000),
          }),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          const freshStore = await chrome.storage.local.get(['pairedCookieCache']);
          const nextCache = freshStore.pairedCookieCache || {};
          delete nextCache[`${portalUrl}|${moodleOrigin}`];
          await chrome.storage.local.set({ pairedCookieCache: nextCache });
        }
        return { success: false, status: res.status, needsLogin: res.status === 401, error: data.detail || `HTTP ${res.status}` };
      }

      const freshStore = await chrome.storage.local.get(['pairedCookieCache']);
      const nextCache = freshStore.pairedCookieCache || {};
      nextCache[`${portalUrl}|${moodleOrigin}`] = {
        cookieHash,
        pairedAt: Date.now(),
        owner_id: data.owner_id,
        google_linked: Boolean(data.google_linked),
        _autoAttempted: true,
      };
      await chrome.storage.local.set({ pairedCookieCache: nextCache });
      return { success: true, moodleOrigin, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  })().finally(() => {
    inFlightPairs.delete(dedupKey);
  });

  inFlightPairs.set(dedupKey, runPromise);
  return runPromise;
}

async function syncCookieForUrl(tabUrl, portalUrlOverride, force = false) {
  const origin = extractMoodleOrigin(tabUrl);
  if (!origin || !chrome.cookies) return { success: false, error: 'Unsupported URL or cookies API unavailable' };
  try {
    const cookieObj = await chrome.cookies.get({ url: origin, name: 'MoodleSession' });
    if (!cookieObj || !cookieObj.value) {
      return { success: false, needsLogin: true, error: 'No active MoodleSession cookie found in browser' };
    }
    return await pairMoodleCookie(origin, cookieObj.value, portalUrlOverride, force);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

if (chrome.cookies && chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener((changeInfo) => {
    const cookie = changeInfo && changeInfo.cookie;
    if (!cookie || changeInfo.removed || cookie.name !== 'MoodleSession') return;
    const host = (cookie.domain || '').replace(/^\./, '').toLowerCase();
    if (!SUPPORTED_MOODLE_HOSTS.includes(host)) return;
    pairMoodleCookie(`https://${host}`, cookie.value, null, false);
  });
}

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab || !tab.url) return;
    const origin = extractMoodleOrigin(tab.url);
    if (origin) {
      const lastCheck = lastTabCheckAt.get(origin) || 0;
      if (Date.now() - lastCheck < COOKIE_PAIR_COOLDOWN_MS) return;
      lastTabCheckAt.set(origin, Date.now());
      syncCookieForUrl(tab.url, null, false);
      return;
    }
    const portalOrigin = sanitizePortalUrl(tab.url);
    if (portalOrigin) {
      const lastPortalCheck = lastTabCheckAt.get(portalOrigin) || 0;
      if (Date.now() - lastPortalCheck < COOKIE_PAIR_COOLDOWN_MS) return;
      lastTabCheckAt.set(portalOrigin, Date.now());
      chrome.storage.local.get(['hustleConnections']).then((stored) => {
        const conns = stored.hustleConnections || {};
        Object.entries(conns).forEach(([mOrigin, pOrigin]) => {
          if (pOrigin === portalOrigin) syncCookieForUrl(mOrigin, portalOrigin, false);
        });
      }).catch(() => {});
    }
  });
}

async function getPortalUrl(overrideUrl) {
  if (overrideUrl) {
    return sanitizePortalUrl(overrideUrl) || DEFAULT_PORTAL_URL;
  }
  const stored = await chrome.storage.local.get(['portalUrl']);
  return sanitizePortalUrl(stored.portalUrl) || DEFAULT_PORTAL_URL;
}

async function resolveWorkspaceHeaders(portalUrl) {
  const headers = { 'Content-Type': 'application/json' };
  const storeData = await chrome.storage.local.get(['workspaceTokens']);
  const tokens = storeData.workspaceTokens || {};
  const cached = tokens[portalUrl];
  if (cached && cached.token && Date.now() - (cached.fetchedAt || 0) < COOKIE_PAIR_COOLDOWN_MS) {
    headers['X-Workspace-Token'] = cached.token;
    return headers;
  }

  try {
    const sessRes = await fetch(`${portalUrl}/api/workspace/session`, {
      method: 'GET',
      credentials: 'include',
    });
    if (sessRes.ok) {
      const sessData = await sessRes.json().catch(() => ({}));
      if (sessData.workspace_token) {
        const legacyStr = typeof cached === 'string' ? cached : null;
        if (sessData.auth_mode === 'new_guest' && (cached?.token || legacyStr)) {
          const existingToken = cached?.token || legacyStr;
          headers['X-Workspace-Token'] = existingToken;
          return headers;
        }
        tokens[portalUrl] = { token: sessData.workspace_token, fetchedAt: Date.now() };
        await chrome.storage.local.set({ workspaceTokens: tokens });
        headers['X-Workspace-Token'] = sessData.workspace_token;
        return headers;
      }
    }
  } catch (e) {}

  const fallbackToken = typeof cached === 'string' ? cached : cached?.token;
  if (fallbackToken) {
    headers['X-Workspace-Token'] = fallbackToken;
  }
  return headers;
}

function stripHtmlText(raw) {
  return String(raw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractCoursesFromHtml(html) {
  const found = new Map();
  const re = /<a[^>]+href=["'][^"']*\/course\/view\.php\?[^"']*?\bid=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = Number(m[1]);
    const name = stripHtmlText(m[2]);
    if (id > 1 && name && name.length > 1 && !found.has(id)) {
      found.set(id, { id, fullname: name, shortname: `CRS-${id}` });
    }
  }
  return Array.from(found.values());
}

async function fetchCoursesViaBrowser(moodleOrigin) {
  const myRes = await fetch(`${moodleOrigin}/my/`, { credentials: 'include' });
  const myHtml = await myRes.text().catch(() => '');
  const isLogin = (myRes.url && myRes.url.includes('/login/')) ||
    (myHtml.includes('name="username"') && myHtml.includes('name="password"'));
  if (!myRes.ok || isLogin) {
    return { success: false, status: 401, needsLogin: true, error: 'Увійди в Moodle повторно.' };
  }
  const sessMatch = myHtml.match(/"sesskey"\s*:\s*"([a-zA-Z0-9]+)"/) || myHtml.match(/sesskey=([a-zA-Z0-9]+)/);
  const sesskey = sessMatch ? sessMatch[1] : '';
  if (sesskey) {
    for (const classification of ['all', 'inprogress']) {
      try {
        const ajaxRes = await fetch(
          `${moodleOrigin}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=core_course_get_enrolled_courses_by_timeline_classification`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{
              index: 0,
              methodname: 'core_course_get_enrolled_courses_by_timeline_classification',
              args: { offset: 0, limit: 0, classification, sort: 'fullname' },
            }]),
          }
        );
        if (ajaxRes.ok) {
          const payload = await ajaxRes.json().catch(() => null);
          const courses = Array.isArray(payload) && payload[0] && !payload[0].error ? payload[0].data?.courses : null;
          if (Array.isArray(courses) && courses.length) {
            return { success: true, courses };
          }
        }
      } catch {}
    }
  }
  let courses = extractCoursesFromHtml(myHtml);
  if (!courses.length) {
    try {
      const cpRes = await fetch(`${moodleOrigin}/my/courses.php`, { credentials: 'include' });
      if (cpRes.ok) courses = extractCoursesFromHtml(await cpRes.text());
    } catch {}
  }
  return { success: true, courses };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function extractReadableHtmlText(html) {
  const mainMatch = html.match(/<div[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/section>|<footer|<aside)/i)
    || html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const scope = (mainMatch ? mainMatch[1] : html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ');
  return stripHtmlText(scope).slice(0, 14000);
}

function extractSafeCourseModuleLinks(courseHtml, moodleOrigin) {
  const links = new Map();
  const re = /href=["']([^"']*\/mod\/(page|book|lesson|resource|folder|url)\/view\.php\?[^"']*?\bid=(\d+)[^"']*)["']/gi;
  let m;
  while ((m = re.exec(courseHtml)) !== null) {
    const modname = m[2].toLowerCase();
    const id = Number(m[3]);
    if (!id || links.has(id)) continue;
    try {
      const resolved = new URL(m[1].replace(/&amp;/g, '&'), moodleOrigin);
      if (resolved.origin !== moodleOrigin) continue;
      links.set(id, { module_id: id, modname, url: resolved.href });
    } catch {}
  }
  return Array.from(links.values()).slice(0, 15);
}

function filenameFromResponse(res, fallback) {
  const disp = res.headers?.get?.('content-disposition') || '';
  const m = disp.match(/filename\*=UTF-8''([^;]+)/i) || disp.match(/filename="?([^";]+)"?/i);
  if (m) {
    try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); }
  }
  try {
    const p = new URL(res.url).pathname.split('/').pop();
    if (p && /\.[a-z0-9]{2,5}$/i.test(p)) return decodeURIComponent(p);
  } catch {}
  return fallback;
}

async function fetchSingleBrowserModule(mod, moodleOrigin) {
  const MAX_BYTES = 2.5 * 1024 * 1024;
  try {
    const res = await fetch(mod.url, { credentials: 'include' });
    if (!res.ok) return null;
    if (res.url && res.url.includes('/login/')) return null;

    const ytMatch = (res.url || '').match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s"'<>]+|youtu\.be\/[^\s"'<>]+)/i);
    if (ytMatch) {
      return { module_id: mod.module_id, text_excerpt: `YouTube URL: ${ytMatch[0]}` };
    }

    const ctype = (res.headers?.get?.('content-type') || '').toLowerCase();
    if (ctype && !ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
      const len = Number(res.headers?.get?.('content-length') || 0);
      if (len > MAX_BYTES) return null;
      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
      const fname = filenameFromResponse(res, `module_${mod.module_id}.pdf`);
      if (!/\.(pdf|docx|pptx|txt|md|html|htm|csv|json)$/i.test(fname)) return null;
      return {
        module_id: mod.module_id,
        attachment_filename: fname,
        attachment_base64: arrayBufferToBase64(buf),
      };
    }

    const html = await res.text().catch(() => '');
    if (!html || (html.includes('name="username"') && html.includes('name="password"'))) return null;

    const ytLinks = Array.from(new Set(
      (html.match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s"'<>)]+|embed\/[^\s"'<>/?)]+)|youtu\.be\/[^\s"'<>/?)]+)/gi) || [])
    )).slice(0, 3);

    if (mod.modname === 'resource' || mod.modname === 'folder') {
      const fileMatch = html.match(/href=["']([^"']*pluginfile\.php[^"']+\.(?:pdf|docx|pptx|txt|md|csv)(?:\?[^"']*)?)["']/i);
      if (fileMatch) {
        try {
          const fUrl = new URL(fileMatch[1].replace(/&amp;/g, '&'), moodleOrigin);
          if (fUrl.origin === moodleOrigin) {
            const fRes = await fetch(fUrl.href, { credentials: 'include' });
            if (fRes.ok) {
              const fLen = Number(fRes.headers?.get?.('content-length') || 0);
              if (fLen <= MAX_BYTES) {
                const buf = await fRes.arrayBuffer();
                if (buf && buf.byteLength > 0 && buf.byteLength <= MAX_BYTES) {
                  return {
                    module_id: mod.module_id,
                    text_excerpt: ytLinks.map(u => `YouTube URL: ${u}`).join('\n') || null,
                    attachment_filename: filenameFromResponse(fRes, `module_${mod.module_id}.pdf`),
                    attachment_base64: arrayBufferToBase64(buf),
                  };
                }
              }
            }
          }
        } catch {}
      }
    }

    const text = extractReadableHtmlText(html);
    const ytText = ytLinks.map(u => `YouTube URL: ${u}`).join('\n');
    const combined = [ytText, text].filter(Boolean).join('\n\n').slice(0, 15000);
    return combined ? { module_id: mod.module_id, text_excerpt: combined } : null;
  } catch {
    return null;
  }
}

async function syncCourseViaBrowser(moodleOrigin, portalUrl, courseId, courseTitle, shortname) {
  const courseRes = await fetch(`${moodleOrigin}/course/view.php?id=${Number(courseId)}`, { credentials: 'include' });
  const courseHtml = await courseRes.text().catch(() => '');
  const isLogin = (courseRes.url && courseRes.url.includes('/login/')) ||
    (courseHtml.includes('name="username"') && courseHtml.includes('name="password"'));
  if (!courseRes.ok || isLogin || !courseHtml) {
    return { success: false, status: 401, needsLogin: true, error: 'Не вдалося завантажити сторінку курсу в Moodle.' };
  }

  const targets = extractSafeCourseModuleLinks(courseHtml, moodleOrigin);
  const moduleContents = [];
  if (targets.length) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (cursor < targets.length) {
        const mod = targets[cursor++];
        const item = await fetchSingleBrowserModule(mod, moodleOrigin);
        if (item) moduleContents.push(item);
      }
    });
    await Promise.all(workers);
  }

  const res = await fetch(`${portalUrl}/api/workspace/courses/${Number(courseId)}/sync-moodle`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      course_title: courseTitle || undefined,
      shortname: shortname || undefined,
      course_html: courseHtml.slice(0, 1800000),
      module_contents: moduleContents,
      fetch_files: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { success: false, status: res.status, error: data.detail || `HTTP ${res.status}` };
  }
  return { success: true, data };
}

async function getMoodleContext(moodleOrigin) {
  const myRes = await fetch(`${moodleOrigin}/my/`, { credentials: 'include' });
  const myHtml = await myRes.text().catch(() => '');
  const isLogin = (myRes.url && myRes.url.includes('/login/')) ||
    (myHtml.includes('name="username"') && myHtml.includes('name="password"'));
  if (!myRes.ok || isLogin || !myHtml) {
    return { ok: false, status: 401, needsLogin: true, error: 'Увійди в Moodle повторно.' };
  }
  const sessMatch = myHtml.match(/"sesskey"\s*:\s*"([a-zA-Z0-9]+)"/) || myHtml.match(/sesskey=([a-zA-Z0-9]+)/);
  const uidMatch = myHtml.match(/\/user\/profile\.php\?id=(\d+)/)
    || myHtml.match(/"userId":\s*(\d+)/)
    || myHtml.match(/"userid":\s*(\d+)/)
    || myHtml.match(/data-userid="(\d+)"/);
  return {
    ok: true,
    sesskey: sessMatch ? sessMatch[1] : '',
    userId: uidMatch ? Number(uidMatch[1]) : 0,
    myHtml,
  };
}

async function callMoodleAjax(moodleOrigin, sesskey, methodname, args) {
  if (!sesskey) return null;
  const res = await fetch(
    `${moodleOrigin}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=${encodeURIComponent(methodname)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ index: 0, methodname, args }]),
    }
  );
  if (!res.ok) return null;
  const payload = await res.json().catch(() => null);
  if (Array.isArray(payload) && payload[0] && !payload[0].error) {
    return payload[0].data;
  }
  return null;
}

async function fetchAssignmentsViaBrowser(moodleOrigin, portalUrl = null, courseId = null) {
  const ctx = await getMoodleContext(moodleOrigin);
  if (!ctx.ok) return { success: false, status: ctx.status, needsLogin: ctx.needsLogin, error: ctx.error };

  let events = [];
  if (courseId) {
    const data = await callMoodleAjax(moodleOrigin, ctx.sesskey, 'core_calendar_get_action_events_by_course', {
      courseid: Number(courseId),
      timesortfrom: 0,
      limitnum: 50,
    });
    if (Array.isArray(data?.events)) events = data.events;
  } else {
    const recentFrom = Math.max(0, Math.floor(Date.now() / 1000) - 30 * 86400);
    const [recentData, allData, coursesData] = await Promise.all([
      callMoodleAjax(moodleOrigin, ctx.sesskey, 'core_calendar_get_action_events_by_timesort', {
        timesortfrom: recentFrom,
        limitnum: 50,
      }),
      callMoodleAjax(moodleOrigin, ctx.sesskey, 'core_calendar_get_action_events_by_timesort', {
        timesortfrom: 0,
        limitnum: 50,
      }),
      callMoodleAjax(moodleOrigin, ctx.sesskey, 'core_course_get_enrolled_courses_by_timeline_classification', {
        offset: 0,
        limit: 0,
        classification: 'all',
        sort: 'fullname',
      }),
    ]);
    const batches = [recentData?.events || [], allData?.events || []];
    const enrolled = Array.isArray(coursesData?.courses) ? coursesData.courses.slice(0, 25) : [];
    if (enrolled.length) {
      let cIdx = 0;
      const cWorkers = Array.from({ length: Math.min(4, enrolled.length) }, async () => {
        while (cIdx < enrolled.length) {
          const course = enrolled[cIdx++];
          const cRes = await callMoodleAjax(moodleOrigin, ctx.sesskey, 'core_calendar_get_action_events_by_course', {
            courseid: Number(course.id),
            timesortfrom: 0,
            limitnum: 50,
          });
          if (Array.isArray(cRes?.events)) batches.push(cRes.events);
        }
      });
      await Promise.all(cWorkers);
    }
    const seen = new Set();
    for (const batch of batches) {
      for (const ev of batch) {
        const cid = Number(ev.course?.id || 0);
        const key = `${cid}:${ev.id || ev.instance || ev.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(ev);
      }
    }
  }

  const assignments = events.map((ev) => {
    const modname = ev.modulename || 'assign';
    const rawId = Number(ev.instance || ev.id || 0);
    let cmid = Number(ev.cmid || 0);
    if (!cmid && ev.url) {
      const m = String(ev.url).match(/[?&]id=(\d+)/);
      if (m) cmid = Number(m[1]);
    }
    return {
      id: rawId,
      cmid: cmid || rawId,
      course_id: Number(ev.course?.id || courseId || 0),
      course_name: ev.course?.fullname || '',
      name: ev.name || ev.activityname || 'Завдання',
      duedate: Number(ev.timesort || ev.timestart || 0) || null,
      allowsubmissionsfromdate: null,
      intro: ev.description ? stripHtmlText(ev.description) : '',
      modulename: modname,
    };
  });

  if (!assignments.length && courseId) {
    try {
      const idxRes = await fetch(`${moodleOrigin}/mod/assign/index.php?id=${Number(courseId)}`, { credentials: 'include' });
      if (idxRes.ok) {
        const idxHtml = await idxRes.text().catch(() => '');
        const seenCmids = new Set();
        const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
        let rm;
        while ((rm = rowRe.exec(idxHtml)) !== null) {
          const rowHtml = rm[1];
          const linkMatch = rowHtml.match(/<a[^>]+href=["'][^"']*\/mod\/assign\/view\.php\?[^"']*?\bid=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
          if (!linkMatch) continue;
          const cmid = Number(linkMatch[1]);
          const name = stripHtmlText(linkMatch[2]);
          if (!cmid || !name || seenCmids.has(cmid)) continue;
          seenCmids.add(cmid);
          const tsMatch = rowHtml.match(/data-timestamp=["'](\d+)["']/i);
          assignments.push({
            id: cmid,
            cmid,
            course_id: Number(courseId),
            course_name: '',
            name,
            duedate: tsMatch ? Number(tsMatch[1]) : null,
            allowsubmissionsfromdate: null,
            intro: '',
            modulename: 'assign',
          });
        }
      }
    } catch {}
  }

  if (portalUrl && assignments.length) {
    try {
      const saveRes = await fetch(`${portalUrl}/api/assignments/from-browser`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ course_id: courseId ? Number(courseId) : null, assignments }),
      });
      if (saveRes.ok) {
        const saved = await saveRes.json().catch(() => null);
        if (saved && Array.isArray(saved.assignments)) {
          return { success: true, total: saved.total ?? saved.assignments.length, assignments: saved.assignments };
        }
      }
    } catch {}
  }

  return { success: true, total: assignments.length, assignments };
}

async function fetchGradesViaBrowser(moodleOrigin, portalUrl, courseId = null) {
  const ctx = await getMoodleContext(moodleOrigin);
  if (!ctx.ok) return { success: false, status: ctx.status, needsLogin: ctx.needsLogin, error: ctx.error };

  let targets = [];
  if (courseId) {
    targets = [{ id: Number(courseId), fullname: `Course #${courseId}` }];
  } else {
    const cRes = await fetchCoursesViaBrowser(moodleOrigin);
    targets = (cRes.courses || []).slice(0, 12);
  }

  const payloadCourses = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, Math.max(1, targets.length)) }, async () => {
    while (cursor < targets.length) {
      const c = targets[cursor++];
      const cid = Number(c.id);
      let ajaxItems = null;
      if (ctx.sesskey && ctx.userId) {
        const gData = await callMoodleAjax(moodleOrigin, ctx.sesskey, 'gradereport_user_get_grade_items', {
          courseid: cid,
          userid: ctx.userId,
        });
        if (Array.isArray(gData?.usergrades) && gData.usergrades[0]?.gradeitems) {
          ajaxItems = gData.usergrades[0].gradeitems;
        }
      }
      if (ajaxItems) {
        payloadCourses.push({ course_id: cid, course_fullname: c.fullname || `Course #${cid}`, grade_items: ajaxItems });
        continue;
      }
      try {
        const gRes = await fetch(`${moodleOrigin}/grade/report/user/index.php?id=${cid}`, { credentials: 'include' });
        const gHtml = await gRes.text().catch(() => '');
        if (gRes.ok && gHtml) {
          payloadCourses.push({ course_id: cid, course_fullname: c.fullname || `Course #${cid}`, report_html: gHtml.slice(0, 600000) });
        }
      } catch {}
    }
  });
  await Promise.all(workers);

  const res = await fetch(`${portalUrl}/api/grades/from-browser`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courses: payloadCourses }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { success: false, status: res.status, error: data.detail || `HTTP ${res.status}` };
  }
  return { success: true, courses: data.courses || [] };
}

async function checkUpdatesViaBrowser(moodleOrigin, portalUrl, courseId, force = true) {
  const courseRes = await fetch(`${moodleOrigin}/course/view.php?id=${Number(courseId)}`, { credentials: 'include' });
  const courseHtml = await courseRes.text().catch(() => '');
  const isLogin = (courseRes.url && courseRes.url.includes('/login/')) ||
    (courseHtml.includes('name="username"') && courseHtml.includes('name="password"'));
  if (!courseRes.ok || isLogin || !courseHtml) {
    return { success: false, status: 401, needsLogin: true, error: 'Не вдалося перевірити оновлення в Moodle.' };
  }
  const res = await fetch(
    `${portalUrl}/api/workspace/courses/${Number(courseId)}/check-updates?force=${force ? 'true' : 'false'}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ course_html: courseHtml.slice(0, 1800000) }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { success: false, status: res.status, error: data.detail || `HTTP ${res.status}` };
  }
  return { success: true, data };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'SYNC_COURSE') {
    (async () => {
      try {
        const portalUrl = await getPortalUrl(message.portalUrl);
        const moodleOrigin = extractMoodleOrigin(message.payload?.moodle_url);
        if (!moodleOrigin || !(await approvedConnection(moodleOrigin, portalUrl))) {
          sendResponse({success:false,error:'Спершу відкрий Hustle → Підключити LMS.'}); return;
        }
        const paired = await syncCookieForUrl(moodleOrigin, portalUrl, true);
        if (!paired.success && (paired.needsLogin || paired.status === 401)) {
          sendResponse({success:false,error:'Увійди в Moodle повторно та спробуй ще раз.'});
          return;
        }
        let headers = await resolveCurrentWorkspaceHeaders(portalUrl);

        let uploadPayload = message.payload;
        let diffSkipped = 0;
        try {
          const probes = [];
          (message.payload.sections || []).forEach((sec) => {
            (sec.modules || []).forEach((m) => {
              if (m.module_hash) {
                probes.push({
                  module_id: m.module_id,
                  section_index: sec.section_index,
                  module_hash: m.module_hash,
                  modname: m.modname || 'resource',
                  name: m.name || '',
                });
              }
            });
          });
          if (probes.length > 0) {
            const diffRes = await fetch(`${portalUrl}/api/sync/diff`, {
              method: 'POST',
              credentials: 'include',
              headers,
              body: JSON.stringify({
                authority: message.payload.authority || 'ucu',
                course_id: message.payload.course_id,
                modules: probes,
              }),
            });
            if (diffRes.ok) {
              const diffData = await diffRes.json();
              const unchangedSet = new Set(diffData.unchanged_module_ids || []);
              diffSkipped = unchangedSet.size;
              if (diffSkipped > 0) {
                uploadPayload = {
                  ...message.payload,
                  sections: (message.payload.sections || []).map((sec) => ({
                    ...sec,
                    modules: (sec.modules || []).map((m) =>
                      unchangedSet.has(m.module_id)
                        ? { ...m, text_excerpt: null, attachment_base64: null }
                        : m
                    ),
                  })),
                };
              }
            }
          }
        } catch (diffErr) {}

        let res = await fetch(`${portalUrl}/api/sync/extension`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(uploadPayload),
        });
        if (res.status === 401) {
          headers = await resolveCurrentWorkspaceHeaders(portalUrl);
          res = await fetch(`${portalUrl}/api/sync/extension`, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify(uploadPayload),
          });
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({
            success: false,
            error: data.detail || `Server responded HTTP ${res.status}`,
          });
          return;
        }

        if (
          message.openWorkspace !== false &&
          typeof data.workspace_url === 'string' &&
          data.workspace_url.startsWith('/') &&
          !data.workspace_url.startsWith('//')
        ) {
          const courseId = data.summary?.course_id || message.payload.course_id;
          chrome.tabs.create({ url: `${portalUrl}/hustle/app.html#course/${encodeURIComponent(courseId)}` });
        }

        sendResponse({ success: true, portalUrl, diffSkipped, data });
      } catch (err) {
        sendResponse({
          success: false,
          error: `Could not reach Portal API (${err.message}). Make sure the FastAPI server is running.`,
        });
      }
    })();
    return true; // keep message channel open for async response
  }

  if (message.type === 'PAIR_MOODLE_COOKIE') {
    (async () => {
      const res = await syncCookieForUrl(message.moodleUrl, message.portalUrl, true);
      sendResponse(res);
    })();
    return true;
  }

  if (message.type === 'OPEN_PORTAL_HOME') {
    (async () => {
      const portalUrl = await getPortalUrl(message.portalUrl);
      chrome.tabs.create({ url: `${portalUrl}/hustle/connect.html` });
      sendResponse({ success: true });
    })();
    return true;
  }

  return false;
});
