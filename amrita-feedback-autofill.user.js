// ==UserScript==
// @name         Amrita Course Feedback Auto-Fill
// @namespace    local
// @version      6.1
// @description  Course Feedback: fills every course in one tab and submits. Class TLP Feedback: one tab per subject, filled up to the OTP.
// @match        https://students.amrita.edu/client/*
// @grant        GM_openInTab
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

// How the portal works (from the saved pages and screenshots):
//  Course Feedback:  list /client/course-feedback-list  -> /client/course-feedback?cid=..&fid=..
//  Class TLP:        list /client/class-feedback        -> /client/feedback?cid=..&sid=..&fid=..
//  - List rows say Pending / Started / Completed; unfinished ones have a "Submit Feedback" link.
//  - Each question is its own page (?c=<n>&...) listed as .step-item[data-step=n]. The active one
//    has a form with radio cards ("1) Strongly Agree", "1) 85 to 100%", ...) and "Save & Next".
//  - Finish: a "Finish" button (Course) or a last step titled FINISH (TLP). Submitting needs an
//    OTP from your Amrita email: "Email OTP" box + "Validate & Finish".
//
// Flow: open a feedback list -> every unfinished item opens in its own background tab -> each tab
// answers all its questions (Save & Next, none skipped) -> goes to Finish -> stops at the OTP.
// You then go tab by tab: SEND OTP, paste the code, and it validates by itself.
// Server errors (504 etc.) are retried forever; a failed save is redone.

(function () {
  'use strict';
  console.log('[feedback-autofill] v6.1 loaded on', location.href);

  // ---------------- Settings ----------------
  const ANSWER = 'Strongly Agree';  // option to pick; if a question doesn't have it, option 1 is picked
  const COMMENT = 'Good course';    // used only if a question has a text box
  const OPEN_TABS = true;           // on a feedback list, open every unfinished item in its own tab
                                    // One tab fills at a time: the portal handles one request per
                                    // login at a time, so parallel tabs only cause 504s. The next
                                    // tab opens when the current one reaches its OTP.
  const GO_TO_OTP = true;           // after the last question, go to Finish and stop at the OTP
  const AUTO_SEND_OTP = false;      // click SEND OTP by itself. Keep off with many tabs open:
                                    // a new OTP may cancel the previous one
  const DELAY_MS = 700;             // pause before each click/navigation; raise if the site is slow
  const MAX_VISITS_PER_QUESTION = 10; // a question that won't save after this many tries -> stop
  const MAX_STEPS = 120;            // safety limit per item
  const RETRY_MIN_S = 5;            // server error: retry after 5s, doubling...
  const RETRY_MAX_S = 30;           // ...up to every 30s, forever until it loads
  const PAGE_WATCHDOG_S = 90;       // a click/navigation still hanging after this -> reload
  // ------------------------------------------

  // question-page path -> its list page
  const FLOWS = {
    '/client/course-feedback': '/client/course-feedback-list',
    '/client/feedback': '/client/class-feedback',
  };
  const LISTS = Object.values(FLOWS);
  // Course Feedback asks for an OTP only once at the start, so it runs in a single tab:
  // list -> course -> questions -> Finish -> list -> next course. Class TLP asks for an OTP
  // on every subject, so it gets one tab per subject that stops at the OTP.
  const SAME_TAB_PATHS = ['/client/course-feedback-list', '/client/course-feedback'];
  const MAX_TRIES_PER_ITEM = 3;     // Course Feedback: still Pending after this many runs -> skip it

  // Shared by all tabs (localStorage): on/off, items already opened, items finished.
  // Per tab (sessionStorage): this tab's progress and its error-retry counters.
  const mk = (area) => ({
    get: (k, d) => { try { const v = window[area].getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { v == null ? window[area].removeItem(k) : window[area].setItem(k, JSON.stringify(v)); } catch {} },
  });
  const L = mk('localStorage'), S = mk('sessionStorage');
  const K_ON = 'af-enabled', K_OPENED = 'af-opened', K_DONE = 'af-done', K_SENT = 'af-otp-sent',
    K_RUN = 'af-run', K_ERR = 'af-errors', K_CHILD = 'af-child',
    K_QUEUE = 'af-queue', K_WORK = 'af-working', K_HANDED = 'af-handed', K_LISTS = 'af-lists-done';
  const enabled = () => L.get(K_ON, true);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const btnText = (b) => norm(b.innerText || b.value);
  const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const findButton = (re, root = document) =>
    [...root.querySelectorAll('button, a, input[type=button], input[type=submit]')]
      .find((b) => !b.closest('#af-panel') && isVisible(b) && re.test(btnText(b)));

  const path = location.pathname.replace(/\/+$/, '');
  const sameTab = SAME_TAB_PATHS.includes(path);
  const K_TRIES = 'af-tries';
  // Course Feedback only: back to the list in this tab, which opens the next course.
  const goList = (msg) => go(location.origin + FLOWS[path], msg || 'Course done. Back to the list…');
  const params = new URLSearchParams(location.search);
  const keyOf = (p) => [p.get('cid'), p.get('sid') || '', p.get('fid')].join('|');
  const markDone = (key) => { const d = L.get(K_DONE, {}); d[key] = Date.now(); L.set(K_DONE, d); };
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // Load a page for real. Dropping the "#af-tab" part matters: setting location to the same
  // address with only a #hash just jumps within the page and never reloads it.
  const navTo = (url) => { location.href = String(url).split("#")[0]; };

  function openTab(url) {
    if (typeof GM_openInTab === 'function') GM_openInTab(url, { active: false, insert: true, setParent: true });
    else window.open(url, '_blank');
  }

  // ---------- One tab at a time ----------
  // The list page puts unfinished items in a queue and opens the first. When a tab reaches its
  // OTP (or finishes / gives up), it opens the next one. The list page also opens the next one
  // if the current tab goes quiet for 2 minutes (closed, frozen...), and reopens that subject.
  const STALE_MS = 2 * 60 * 1000;
  const K_ATOTP = 'af-at-otp'; // subjects whose tab is waiting for your OTP
  const atOtp = (k) => { const m = L.get(K_ATOTP, {}); return m[k] && Date.now() - m[k] < 30 * 60 * 1000; };
  function openNext() {
    const q = L.get(K_QUEUE, []);
    const done = L.get(K_DONE, {});
    let item;
    do { item = q.shift(); } while (item && (done[item.key] || atOtp(item.key)));
    L.set(K_QUEUE, q);
    if (!item) { L.set(K_WORK, null); return null; }
    L.set(K_WORK, { key: item.key, name: item.name, url: item.url, at: Date.now() });
    const opened = L.get(K_OPENED, {});
    opened[item.key] = Date.now();
    L.set(K_OPENED, opened);
    openTab(item.url + '#af-tab');
    return item;
  }
  function heartbeat() {
    const w = L.get(K_WORK, null);
    if (w && w.key === keyOf(params)) { w.at = Date.now(); L.set(K_WORK, w); }
  }
  // This tab no longer needs the server: let the next one start (once per tab).
  function handoff() {
    const key = keyOf(params);
    if (S.get(K_HANDED, null) === key) return;
    S.set(K_HANDED, key);
    const w = L.get(K_WORK, null);
    if (!w || w.key === key || Date.now() - w.at > STALE_MS) openNext();
  }

  // ---------- Server errors (504 etc.) ----------
  // Real portal pages have #kt_body; error pages are a bare "504 Gateway Time-out" etc.
  function isErrorPage() {
    if (document.getElementById('kt_body')) return false;
    const t = norm(document.title + ' ' + (document.body?.innerText || '')).slice(0, 500);
    return !t || /\b(50[0-9]|429)\b|gateway|time-?out|service unavailable|didn't respond|server error|too many requests/i.test(t);
  }

  // Wait, then load again (as a GET, never re-posting), forever. If a Save & Next failed,
  // go back to that question and answer it again.
  function retryLater() {
    const run = S.get(K_RUN, null);
    const target = (run && run.pendingUrl) || location.href;
    if (run && run.pending) {
      run.pending = null; // that save did NOT go through
      run.pendingUrl = null;
      S.set(K_RUN, run);
    }
    const errs = S.get(K_ERR, {});
    const n = (errs[target] || 0) + 1;
    errs[target] = n;
    S.set(K_ERR, errs);
    let wait = Math.min(RETRY_MIN_S * 2 ** (n - 1), RETRY_MAX_S);
    const show = () => { heartbeat(); status(`Server error. Retrying in ${wait}s… (attempt ${n})`); };
    show();
    const timer = setInterval(() => {
      if (!enabled()) { clearInterval(timer); return status('Paused.'); }
      if (--wait <= 0) {
        clearInterval(timer);
        status(`Reloading (attempt ${n})… waiting for the portal to answer. This can take a minute; ` +
          'the old error stays on screen until it does.');
        navTo(target);
        watchdog(target); // the reload itself can hang too
      } else show();
    }, 1000);
  }

  // After a click or navigation: if the page is still hanging, load it again.
  function watchdog(url = location.href) {
    let left = PAGE_WATCHDOG_S;
    const timer = setInterval(() => {
      if (!enabled()) return clearInterval(timer);
      heartbeat();
      if (--left <= 0) {
        clearInterval(timer);
        status('The portal never answered. Trying again…');
        navTo(url);
        watchdog(url);
      }
    }, 1000);
  }

  function go(url, msg) {
    status(msg);
    setTimeout(() => {
      if (!enabled()) return status('Paused.');
      navTo(url);
      watchdog();
    }, DELAY_MS);
  }

  // ---------- List pages: open every unfinished item in its own tab ----------
  async function onList() {
    if (!OPEN_TABS) return status('Opening tabs is off (OPEN_TABS = false).');
    const done = L.get(K_DONE, {});
    const rows = [...document.querySelectorAll('tr')]
      .map((tr) => {
        const link = [...tr.querySelectorAll('a[href*="feedback?"]')].find((a) => /submit feedback/i.test(btnText(a)));
        if (!link) return null;
        const cells = [...tr.children].map((c) => norm(c.innerText));
        if (cells.some((t) => /^(completed|submitted)$/i.test(t))) return null;
        const key = keyOf(new URL(link.href).searchParams);
        const name = cells.filter((t) => t && !/^\d+$/.test(t) && !/submit feedback|^(pending|started)$/i.test(t)).join(' · ') || key;
        return { link, key, name };
      })
      .filter((r) => r && !done[r.key]);

    // Which lists are finished. A list counts as finished for 12 hours after it was last seen empty.
    const listsDone = L.get(K_LISTS, {});
    const other = LISTS.find((p) => p !== path);
    const NAMES = { '/client/course-feedback-list': 'Course Feedback', '/client/class-feedback': 'Class TLP Feedback' };
    if (rows.length) { delete listsDone[path]; L.set(K_LISTS, listsDone); }

    if (!rows.length) {
      L.set(K_TRIES, null);
      listsDone[path] = Date.now();
      L.set(K_LISTS, listsDone);
      const otherDone = listsDone[other] && Date.now() - listsDone[other] < 12 * 60 * 60 * 1000;
      if (otherDone) {
        document.title = '✅ Feedback done';
        return status(`✅ All done: ${NAMES[path]} and ${NAMES[other]} are both complete.`);
      }
      // This list is done: go to the other one (with a button in case you want to go now).
      let left = 5;
      status(`✅ ${NAMES[path]} is done. Going to ${NAMES[other]} in ${left}s…`);
      addPanelButton(`Go to ${NAMES[other]} now`, () => navTo(location.origin + other));
      const timer = setInterval(() => {
        if (!enabled()) { clearInterval(timer); return status(`✅ ${NAMES[path]} is done. Paused.`); }
        if (--left <= 0) { clearInterval(timer); navTo(location.origin + other); }
        else status(`✅ ${NAMES[path]} is done. Going to ${NAMES[other]} in ${left}s…`);
      }, 1000);
      return;
    }

    // Course Feedback: everything in this one tab, one course after another (only one OTP).
    if (sameTab) {
      const tries = L.get(K_TRIES, {});
      const todo = rows.find((r) => (tries[r.key] || 0) < MAX_TRIES_PER_ITEM);
      if (!todo) {
        addPanelButton(`Go to ${NAMES[other]}`, () => navTo(location.origin + other));
        return status('Could not finish: ' + rows.map((r) => r.name).join('; ') +
          `. Open these yourself, or go on to ${NAMES[other]}.`);
      }
      tries[todo.key] = (tries[todo.key] || 0) + 1;
      L.set(K_TRIES, tries);
      S.set(K_RUN, null);
      return go(todo.link.href, `Opening ${todo.name} (${rows.length} left)…`);
    }

    // Class TLP Feedback (OTP for every subject): one tab per subject.
    // Skip subjects already waiting for your OTP in another tab, and the one filling right now.
    const busy = () => { const x = L.get(K_WORK, null); return x && Date.now() - x.at < STALE_MS ? x : null; };
    const w = busy();
    const waitingOtp = rows.filter((r) => atOtp(r.key)).length;
    const todo = rows.filter((r) => !atOtp(r.key) && !(w && w.key === r.key));
    if (!todo.length && !w) {
      return status(`All ${rows.length} unfinished subjects are waiting for your OTP in other tabs.`);
    }

    L.set(K_QUEUE, todo.map((r) => ({ url: r.link.href, key: r.key, name: r.name })));
    if (!w) openNext();

    // Keep an eye on the queue. If the filling tab goes quiet (closed, frozen), reopen that
    // subject and carry on.
    const tick = () => {
      if (!enabled()) return status('Paused.');
      const cur = busy();
      if (!cur) {
        const old = L.get(K_WORK, null);
        if (old && old.url && !L.get(K_DONE, {})[old.key] && !atOtp(old.key)) {
          const q = L.get(K_QUEUE, []);
          if (!q.some((i) => i.key === old.key)) q.unshift({ url: old.url, key: old.key, name: old.name });
          L.set(K_QUEUE, q);
        }
        L.set(K_WORK, null);
        if (L.get(K_QUEUE, []).length) { openNext(); return; }
      }
      const q = L.get(K_QUEUE, []);
      if (cur) status(`Filling in another tab: ${cur.name}. ${q.length} more after it. ` +
        'Each tab stops at its OTP, then the next one opens. No tab showing up? Click Pause, then Resume.');
      else {
        status('All subjects opened. Go tab by tab: SEND OTP, paste the code from your email. ' +
          'This list checks again every minute and moves on once everything says Completed.');
        // Reload the list now and then, so it notices when the OTPs are all done.
        if (++idleTicks >= 12) navTo(location.href);
      }
    };
    let idleTicks = 0;
    tick();
    setInterval(tick, 5000);
  }

  // ---------- Question pages ----------
  // A question form has answer options (the OTP form on the FINISH step doesn't).
  const findForm = () =>
    [...document.querySelectorAll('.step-item.active form, .step-content form')]
      .find((f) => f.querySelector('input[type=radio], textarea'));

  // "...you need to verify OTP which will be sending to your amrita Email ID. [SEND OTP]"
  function isOtpPage() {
    const t = norm(document.getElementById('kt_content')?.innerText || document.body.innerText);
    return /\bOTP\b/i.test(t) || !!document.querySelector('input[name*="otp" i], input[id*="otp" i], input[placeholder*="otp" i]');
  }

  function otpInput() {
    const root = document.getElementById('kt_content') || document.body;
    const boxes = [...root.querySelectorAll('input')].filter((i) =>
      isVisible(i) && !i.closest('#af-panel') && !/^(hidden|radio|checkbox|submit|button)$/i.test(i.type));
    return boxes.find((i) => /otp|code/i.test(i.name + i.id + i.placeholder)) || boxes[0] || null;
  }

  // Stay on the OTP page. You click SEND OTP (unless AUTO_SEND_OTP) and type the code;
  // once the code is in the box, the script clicks "Validate & Finish".
  function waitForOtp() {
    if (!sameTab) {
      const m = L.get(K_ATOTP, {});
      m[keyOf(params)] = Date.now(); // don't reopen this subject; it's waiting for you here
      L.set(K_ATOTP, m);
      handoff(); // the next tab can start filling while this one waits for you
    }
    const atFinish = /finish/i.test(norm(document.querySelector('.step-item.active .step-title')?.innerText));
    const sentKey = location.pathname + location.search;
    const sent = L.get(K_SENT, {});
    const sendBtn = findButton(/send\s*otp/i);
    if (AUTO_SEND_OTP && sendBtn && !otpInput() && !(sent[sentKey] && Date.now() - sent[sentKey] < 3 * 60 * 1000)) {
      sent[sentKey] = Date.now();
      L.set(K_SENT, sent);
      status('📧 Sending the OTP to your Amrita email…');
      setTimeout(() => enabled() && sendBtn.click(), DELAY_MS);
    } else {
      status((atFinish ? '🔐 All questions answered. ' : '🔐 OTP needed before the questions. ') +
        (otpInput() ? 'Paste the code from your email into the box. It validates by itself.'
          : 'Click SEND OTP, then paste the code from your email. It validates by itself.'));
    }
    const baseTitle = document.title;
    let flash = false, focused = false, lastVal = '', stable = 0, triedVal = '';
    const timer = setInterval(() => {
      const r = S.get(K_RUN, null);
      if (r) { r.at = Date.now(); S.set(K_RUN, r); }
      document.title = (flash = !flash) ? '🔐 Enter OTP' : baseTitle; // easy to spot among tabs
      if (!enabled()) return;
      if (findForm()) { clearInterval(timer); document.title = baseTitle; return onQuestion(); }
      if (!isOtpPage()) {
        clearInterval(timer);
        document.title = baseTitle;
        status('OTP done. Continuing…');
        navTo(location.href);
        return;
      }
      const box = otpInput();
      if (!box) return;
      if (!focused && document.hasFocus()) { box.focus(); focused = true; }
      // Validate once the code has been typed and stopped changing.
      const val = (box.value || '').trim();
      stable = val && val === lastVal ? stable + 1 : 0;
      lastVal = val;
      const full = box.maxLength > 0 && box.maxLength <= 8 ? val.length >= box.maxLength : val.length >= 4 && stable >= 3;
      if (full && val !== triedVal) {
        const verify = findButton(/verify|submit|confirm|validate|^ok$|finish/i, box.form || document) ||
          findButton(/verify|submit|confirm|validate/i);
        if (verify && !/send|resend|back/i.test(btnText(verify))) {
          triedVal = val;
          if (r && (atFinish || /finish/i.test(btnText(verify)))) { r.finished = true; S.set(K_RUN, r); }
          status('Validating the OTP…');
          verify.click();
          watchdog();
        }
      }
    }, 1000);
  }

  function chooseAnswer(form) {
    const radios = [...form.querySelectorAll('input[type=radio]')];
    if (radios.length) {
      const want = new RegExp('^(\\d+\\)\\s*)?' + esc(ANSWER) + '$', 'i');
      const labelOf = (r) => form.querySelector(`label[for="${r.id}"]`);
      const pick = radios.find((r) => want.test(norm(labelOf(r)?.innerText))) || radios[0];
      labelOf(pick)?.click(); // the radio is hidden; the label is the visible card
      pick.checked = true;
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (const box of form.querySelectorAll('textarea, input[type=text]')) if (!box.value) box.value = COMMENT;
  }

  function stepUrl(n) {
    const a = document.querySelector(`.step-item[data-step="${n}"] a[href]`);
    if (a) return a.href;
    const p = new URLSearchParams(location.search);
    p.set('c', n);
    return `${location.origin}${path}?${p}`;
  }

  async function onQuestion() {
    const key = keyOf(params);
    let run = S.get(K_RUN, null);
    if (!run || run.key !== key) run = { key, saved: [], visits: {}, steps: 0 };
    run.at = Date.now();
    run.list = FLOWS[path];
    run.sameTab = sameTab;
    const keep = () => S.set(K_RUN, run);
    // Can't go on with this one: Course Feedback moves to the next course (the list retries
    // it later, up to MAX_TRIES_PER_ITEM); a TLP tab stops here and lets the next tab start.
    const stop = (msg) => {
      keep();
      if (sameTab) return goList(msg.replace(/ (Answer|Finish) .*$/, '') + ' Moving on…');
      status(msg);
      handoff();
    };
    heartbeat();

    // Course Feedback has no OTP after Finish, so once Finish is clicked this course is done:
    // go straight back to the list, whatever the page now shows.
    if (sameTab && run.finished) {
      markDone(key);
      S.set(K_RUN, null);
      return goList('Course submitted. Back to the list for the next one…');
    }

    // OTP page (before the questions or on the FINISH step): stay here.
    if (!findForm() && isOtpPage()) { keep(); return waitForOtp(); }

    if (run.finished) {
      markDone(key);
      S.set(K_RUN, null);
      if (sameTab) return goList('Course submitted. Back to the list for the next one…');
      document.title = '✅ ' + document.title;
      handoff();
      return status('✅ Submitted. You can close this tab.');
    }

    const allSteps = [...document.querySelectorAll('.step-item[data-step]')];
    const isFinishStep = (s) => /finish/i.test(norm(s.querySelector('.step-title')?.innerText));
    const steps = allSteps.filter((s) => !isFinishStep(s)).map((s) => +s.dataset.step);
    const finishStep = allSteps.find(isFinishStep);
    if (!steps.length) {
      markDone(key);
      return stop('Nothing to fill here (already submitted?). You can close this tab.');
    }

    // The last Save & Next came back with a normal page: that answer is saved.
    if (run.pending) {
      if (!run.saved.includes(run.pending)) run.saved.push(run.pending);
      run.pending = null;
      run.pendingUrl = null;
    }
    if (++run.steps > MAX_STEPS) return stop('Stopped after too many steps. Finish this one by hand.');

    const form = findForm();
    const activeEl = document.querySelector('.step-item.active[data-step]');
    const cur = activeEl ? +activeEl.dataset.step : +(params.get('c') || 0);

    // We asked for question N but the portal sent us back here: this one isn't really saved.
    if (run.navTarget && cur && cur !== run.navTarget && run.saved.includes(cur)) {
      run.saved = run.saved.filter((n) => n !== cur);
    }
    run.navTarget = null;

    // 1) Current question not saved yet: answer it and Save & Next.
    if (form && steps.includes(cur) && !run.saved.includes(cur)) {
      run.visits[cur] = (run.visits[cur] || 0) + 1;
      if (run.visits[cur] > MAX_VISITS_PER_QUESTION) {
        return stop(`Question ${cur} won't save. Answer it by hand, then refresh this tab.`);
      }
      const saveBtn = findButton(/save\s*&\s*next/i, form) || findButton(/save\s*&\s*next/i);
      if (saveBtn) {
        chooseAnswer(form);
        run.pending = cur;
        run.pendingUrl = stepUrl(cur);
        keep();
        status(`Question ${cur}/${steps.length}: Save & Next`);
        await sleep(DELAY_MS);
        if (!enabled()) return status('Paused.');
        saveBtn.click();
        watchdog();
        return;
      }
      run.saved.push(cur); // only "Next" shown: answered earlier
    }

    // 2) Some question still not saved: go to it.
    const missing = steps.filter((n) => !run.saved.includes(n));
    if (missing.length) {
      const k = 'nav' + missing[0];
      run.visits[k] = (run.visits[k] || 0) + 1;
      run.navTarget = missing[0];
      if (run.visits[k] > MAX_VISITS_PER_QUESTION) return stop(`Can't open question ${missing[0]}. Finish this one by hand.`);
      keep();
      return go(stepUrl(missing[0]), `Going to question ${missing[0]}/${steps.length}…`);
    }

    // 3) Every question saved: go to Finish, which asks for the OTP.
    if (!GO_TO_OTP) return stop('All questions saved. Click Finish yourself when ready.');
    const finishBtn = findButton(/^(finish|final submit|submit)$/i);
    if (!finishBtn) {
      const target = finishStep?.querySelector('a[href]')?.href || stepUrl(steps[steps.length - 1]);
      if (!run.finishNav) {
        run.finishNav = true;
        keep();
        return go(target, 'All questions saved. Opening the FINISH step…');
      }
      return stop('All questions saved, but no Finish button found. Finish this one by hand.');
    }
    run.finished = true; // the Finish button submits (possibly after an OTP, handled above)
    keep();
    status(`All ${steps.length} questions saved. Clicking Finish…`);
    finishBtn.scrollIntoView({ block: 'center' });
    await sleep(DELAY_MS);
    if (!enabled()) { run.finished = false; keep(); return status('Paused.'); }
    pageWin.confirm = () => true; // accept a browser "Are you sure?" box
    finishBtn.click();
    watchdog();
    for (let i = 0; i < 10; i++) { // ...or an in-page confirmation dialog
      await sleep(500);
      const dlg = document.querySelector('.swal2-container, .modal.show, [role=dialog]');
      const ok = dlg && findButton(/^(yes|ok|confirm|submit|finish|yes.*)$/i, dlg);
      if (ok) { ok.click(); break; }
    }
  }

  // ---------- Panel ----------
  let statusEl;
  function status(msg) {
    if (statusEl) statusEl.textContent = msg;
    console.log('[feedback-autofill]', msg);
  }

  function addPanel() {
    if (document.getElementById('af-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'af-panel';
    panel.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#111;color:#fff;' +
      'padding:10px 12px;border-radius:10px;font:13px system-ui;box-shadow:0 4px 16px #0005;max-width:320px';
    const b = document.createElement('button');
    b.textContent = enabled() ? 'Pause auto-fill' : 'Resume auto-fill';
    b.style.cssText = 'background:#e11d48;color:#fff;border:0;border-radius:6px;padding:6px 10px;' +
      'cursor:pointer;font-weight:600;width:auto';
    b.onclick = () => {
      if (enabled()) { L.set(K_ON, false); b.textContent = 'Resume auto-fill'; status('Paused in every tab.'); }
      else {
        L.set(K_ON, true);
        for (const k of [K_OPENED, K_DONE, K_QUEUE, K_WORK, K_ATOTP, K_TRIES, K_LISTS]) L.set(k, null);
        location.reload();
      }
    };
    statusEl = document.createElement('div');
    statusEl.style.marginTop = '6px';
    statusEl.textContent = 'Feedback auto-fill';
    panel.append(b, statusEl);
    document.body.appendChild(panel);
  }

  function addPanelButton(label, onclick) {
    const panel = document.getElementById('af-panel');
    if (!panel || [...panel.querySelectorAll('button')].some((x) => x.textContent === label)) return;
    const x = document.createElement('button');
    x.textContent = label;
    x.style.cssText = 'background:#0f766e;color:#fff;border:0;border-radius:6px;padding:6px 10px;' +
      'cursor:pointer;font-weight:600;width:auto;margin-left:6px';
    x.onclick = onclick;
    panel.insertBefore(x, statusEl);
  }

  // ---------- Router ----------
  if (location.hash.includes('af-tab')) S.set(K_CHILD, 1); // a tab this script opened
  const isList = LISTS.includes(path);
  const isForm = path in FLOWS;
  const run = S.get(K_RUN, null);
  const midRun = run && Date.now() - (run.at || 0) < 5 * 60 * 1000;

  // Server error page (504 etc.): keep retrying instead of giving up.
  if (isErrorPage()) {
    if (!isList && !isForm && !midRun) return; // not ours
    addPanel();
    if (!enabled()) return status('Paused. Click Resume to continue.');
    return retryLater();
  }
  S.set(K_ERR, null); // page loaded fine: reset retry counters
  if (!isList && !isForm) {
    // Course Feedback got sent somewhere else right after a save/finish: back to its list.
    if (midRun && run.sameTab && run.list && enabled()) navTo(location.origin + run.list);
    return;
  }

  addPanel();
  if (!enabled()) return status('Paused. Click Resume to continue.');
  if (isList && !sameTab && S.get(K_CHILD, 0)) return status('This tab is done. You can close it.');
  setTimeout(isList ? onList : onQuestion, 400);
})();
