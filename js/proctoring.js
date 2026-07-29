// Shared proctoring module — fullscreen lock, tab-switch tracking, and
// window-blur tracking for student-facing "taking" pages. Originally built
// (hardcoded, always-on) inside exam-branded-page.html; extracted here so
// both the Assessment system's assessment/page.html and, later, the Exam
// system's runner can share one implementation. Nothing in this file is
// specific to either system's table/column names — callers own persistence.

// Detect iOS / iPadOS devices, where the Fullscreen API is unavailable.
// Checks the user agent for iPhone/iPad/iPod, plus a fallback for modern
// iPads that report as "MacIntel" but are really iPads (a touchscreen Mac
// is an iPad). Deliberately does NOT match macOS desktop browsers — Macs
// support fullscreen normally and should keep using the lock.
export function isAppleMobile() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  if (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1) return true;
  return false;
}

// settings: { fullscreen_lock, tab_switch_tracking, window_blur_tracking } —
// any flag may be false to disable that specific monitor. A missing/null
// settings object enables everything (caller is expected to have already
// applied its own null/legacy-record fallback, but we default safely too).
export function createProctor({ settings = {}, onStateChange } = {}) {
  const cfg = {
    fullscreen_lock: settings.fullscreen_lock !== false,
    tab_switch_tracking: settings.tab_switch_tracking !== false,
    window_blur_tracking: settings.window_blur_tracking !== false,
  };

  const appleMobile = isAppleMobile();
  // Apple mobile devices can't use the Fullscreen API at all — the lock is
  // simply unavailable there, regardless of the setting. Tab-switch/blur
  // tracking are unaffected and keep working normally.
  const fullscreenActive = cfg.fullscreen_lock && !appleMobile;

  const state = {
    active: false,
    paused: false,
    tabSwitches: 0,
    windowBlurEvents: 0,
    fullscreenExits: 0,
    rightClicksBlocked: 0,
    devtoolsAttempts: 0,
    eventLog: [],
  };

  let wakeLock = null;

  function notify() {
    if (typeof onStateChange === 'function') onStateChange({ ...state, eventLog: state.eventLog.slice() });
  }

  // Pushes a timestamped entry onto the shared event log. Exposed publicly
  // (see returned `logEvent`) so callers can interleave their own lifecycle
  // events (exam_started, exam_submitted, ...) into the same combined log
  // that ships in buildPayload().
  function logEvent(type, detail = '') {
    state.eventLog.push({ ts: new Date().toISOString(), type, detail });
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (err) {
      // Rejected (low battery, permissions, unsupported) — not worth surfacing.
      wakeLock = null;
    }
  }
  async function releaseWakeLock() {
    if (wakeLock) {
      try { await wakeLock.release(); } catch (err) { /* ignore */ }
      wakeLock = null;
    }
  }

  function onVisibilityChange() {
    if (!state.active) return;
    if (document.hidden) {
      state.tabSwitches++;
      logEvent('tab_hidden', `count: ${state.tabSwitches}`);
      notify();
    } else {
      // The OS releases the wake lock whenever the tab is hidden, so
      // re-acquire it each time the student comes back.
      requestWakeLock();
      logEvent('tab_visible');
      notify();
    }
  }

  function onBlur() {
    if (!state.active) return;
    state.windowBlurEvents++;
    logEvent('window_blur', `count: ${state.windowBlurEvents}`);
    notify();
  }

  function onFullscreenChange() {
    if (!state.active || appleMobile) return;
    if (!document.fullscreenElement) {
      state.fullscreenExits++;
      state.paused = true;
      logEvent('fullscreen_exit', `count: ${state.fullscreenExits}`);
    } else {
      state.paused = false;
      logEvent('fullscreen_resumed');
    }
    notify();
  }

  // Right-click and devtools-shortcut blocking are always-on anti-cheat
  // measures, independent of the three configurable monitor toggles.
  function onContextMenu(e) {
    if (!state.active) return;
    e.preventDefault();
    state.rightClicksBlocked++;
    logEvent('right_click_blocked');
    notify();
  }

  function onKeyDown(e) {
    if (!state.active) return;
    if (e.key === 'F12' ||
        (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key)) ||
        (e.ctrlKey && e.key === 'u')) {
      e.preventDefault();
      state.devtoolsAttempts++;
      logEvent('devtools_shortcut_blocked', e.key);
      notify();
    }
  }

  async function requestFullscreen() {
    if (!fullscreenActive) return true;
    try {
      await document.documentElement.requestFullscreen();
      return true;
    } catch (err) {
      return false;
    }
  }

  async function resumeFullscreen() {
    if (!fullscreenActive) return true;
    try {
      await document.documentElement.requestFullscreen();
      return true;
    } catch (err) {
      return false;
    }
  }

  function exitFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function start() {
    state.active = true;
    if (cfg.tab_switch_tracking) document.addEventListener('visibilitychange', onVisibilityChange);
    if (cfg.window_blur_tracking) window.addEventListener('blur', onBlur);
    if (fullscreenActive) document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);
    requestWakeLock();
  }

  function stop() {
    state.active = false;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('keydown', onKeyDown);
    releaseWakeLock();
  }

  // Shape matches the `proctoring` jsonb column on submission tables. Callers
  // that only need the three original fields (e.g. Assessment) can keep
  // ignoring the extra keys — jsonb columns tolerate additional properties.
  function buildPayload() {
    return {
      tab_switches: state.tabSwitches,
      window_blur_events: state.windowBlurEvents,
      fullscreen_exits: state.fullscreenExits,
      right_clicks_blocked: state.rightClicksBlocked,
      devtools_attempts: state.devtoolsAttempts,
      event_log: state.eventLog.slice(),
    };
  }

  // Restores in-progress counts when resuming a saved session.
  function restoreCounts(p) {
    state.tabSwitches = p?.tab_switches || 0;
    state.windowBlurEvents = p?.window_blur_events || 0;
    state.fullscreenExits = p?.fullscreen_exits || 0;
    state.rightClicksBlocked = p?.right_clicks_blocked || 0;
    state.devtoolsAttempts = p?.devtools_attempts || 0;
    state.eventLog = Array.isArray(p?.event_log) ? p.event_log.slice() : [];
  }

  return {
    settings: cfg,
    isAppleMobile: appleMobile,
    fullscreenRequired: fullscreenActive,
    get tabSwitches() { return state.tabSwitches; },
    get windowBlurEvents() { return state.windowBlurEvents; },
    get fullscreenExits() { return state.fullscreenExits; },
    get rightClicksBlocked() { return state.rightClicksBlocked; },
    get devtoolsAttempts() { return state.devtoolsAttempts; },
    get isPaused() { return state.paused; },
    start,
    stop,
    requestFullscreen,
    resumeFullscreen,
    exitFullscreen,
    buildPayload,
    restoreCounts,
    logEvent,
  };
}
