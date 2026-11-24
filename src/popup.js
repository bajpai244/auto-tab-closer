import {
  MAX_TIMEOUT_MINUTES,
  MIN_TIMEOUT_MINUTES,
  extractHostname,
  formatDuration,
  normalizeDomain,
  parseTimeoutMinutes,
} from './core.js';

const THEME_CACHE_KEY = 'atc-theme';
const THEME_STORAGE_KEY = 'uiTheme';

const PROTECTION_LABELS = {
  active: 'Active',
  pinned: 'Pinned',
  audible: 'Audio',
  excluded: 'Excluded',
  'background-active': 'Window active',
};

let appState = null;
let toastTimer = null;

const els = {
  statusDot: document.getElementById('statusDot'),
  statusSubtitle: document.getElementById('statusSubtitle'),
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  enabledToggle: document.getElementById('enabledToggle'),
  tabButtons: Array.from(document.querySelectorAll('.tab-btn')),
  panels: {
    timer: document.getElementById('panel-timer'),
    open: document.getElementById('panel-open'),
    closed: document.getElementById('panel-closed'),
  },
  openCountBadge: document.getElementById('openCountBadge'),
  closedCountBadge: document.getElementById('closedCountBadge'),
  timeoutForm: document.getElementById('timeoutForm'),
  timeoutInput: document.getElementById('timeoutInput'),
  saveTimeoutBtn: document.getElementById('saveTimeoutBtn'),
  timeoutFormatted: document.getElementById('timeoutFormatted'),
  timeoutError: document.getElementById('timeoutError'),
  presetChips: Array.from(document.querySelectorAll('.preset-chip')),
  protectPinnedToggle: document.getElementById('protectPinnedToggle'),
  protectAudibleToggle: document.getElementById('protectAudibleToggle'),
  protectBgActiveToggle: document.getElementById('protectBgActiveToggle'),
  excludeDetails: document.getElementById('excludeDetails'),
  excludedCount: document.getElementById('excludedCount'),
  excludeCurrentBtn: document.getElementById('excludeCurrentBtn'),
  excludeForm: document.getElementById('excludeForm'),
  excludeInput: document.getElementById('excludeInput'),
  excludeError: document.getElementById('excludeError'),
  excludedList: document.getElementById('excludedList'),
  excludedEmpty: document.getElementById('excludedEmpty'),
  totalClosedStat: document.getElementById('totalClosedStat'),
  sweepNowBtn: document.getElementById('sweepNowBtn'),
  openTabsList: document.getElementById('openTabsList'),
  openTabsEmpty: document.getElementById('openTabsEmpty'),
  closedToolbar: document.getElementById('closedToolbar'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  closedHistoryList: document.getElementById('closedHistoryList'),
  closedHistoryEmpty: document.getElementById('closedHistoryEmpty'),
  toast: document.getElementById('toast'),
};

function isCurrentlyDark() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark') {
    return true;
  }
  if (explicit === 'light') {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  try {
    if (theme === 'light' || theme === 'dark') {
      localStorage.setItem(THEME_CACHE_KEY, theme);
    } else {
      localStorage.removeItem(THEME_CACHE_KEY);
    }
  } catch {
    // Ignore storage access errors
  }

  const dark = isCurrentlyDark();
  els.themeToggleBtn.title = dark
    ? 'Switch to light theme'
    : 'Switch to dark theme';
  els.themeToggleBtn.setAttribute('aria-label', els.themeToggleBtn.title);
}

async function loadSavedTheme() {
  // 1. Apply synchronous localStorage cache first for zero flash
  let localTheme = null;
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY);
    if (cached === 'light' || cached === 'dark') {
      localTheme = cached;
    }
  } catch {
    // Ignore storage access errors
  }
  applyTheme(localTheme || 'system');

  // 2. Reconcile with chrome.storage.local (works even if background SW was not reloaded)
  try {
    if (chrome?.storage?.local) {
      const stored = await chrome.storage.local.get(THEME_STORAGE_KEY);
      const saved = stored?.[THEME_STORAGE_KEY];
      if (saved === 'light' || saved === 'dark') {
        applyTheme(saved);
      }
    }
  } catch {
    // Ignore storage read errors
  }
}

async function persistTheme(theme) {
  applyTheme(theme);
  try {
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({ [THEME_STORAGE_KEY]: theme });
    }
  } catch {
    // Ignore storage write errors
  }
  // Also sync to extension settings without letting stale responses revert the UI
  sendMessage({ type: 'UPDATE_SETTINGS', payload: { theme } }).catch(() => {});
}

loadSavedTheme();

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2000);
}

function setActiveTab(tabName) {
  for (const btn of els.tabButtons) {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  }
  for (const [name, panel] of Object.entries(els.panels)) {
    const isActive = name === tabName;
    panel.hidden = !isActive;
    panel.classList.toggle('active', isActive);
  }
}

function updateTimeoutPreview(minutesValue) {
  const parsed = parseTimeoutMinutes(minutesValue);
  if (parsed === null) {
    els.timeoutFormatted.textContent = `Enter ${MIN_TIMEOUT_MINUTES}–${MAX_TIMEOUT_MINUTES} minutes`;
  } else {
    els.timeoutFormatted.textContent = `Closes inactive tabs after ${formatDuration(parsed * 60 * 1000)}`;
  }

  const saved = appState?.settings?.timeoutMinutes;
  const isDirty = saved !== undefined && parsed !== saved;
  els.saveTimeoutBtn.hidden = !isDirty;
}

function renderHeader(settings) {
  els.enabledToggle.checked = settings.enabled;
  els.statusDot.classList.toggle('paused', !settings.enabled);
  if (settings.enabled) {
    const formatted = formatDuration(settings.timeoutMinutes * 60 * 1000);
    els.statusSubtitle.textContent = `Active · ${formatted} stillness`;
  } else {
    els.statusSubtitle.textContent = 'Paused';
  }
}

function renderTimerPanel(state) {
  const { settings, currentTab, totalClosedCount } = state;

  if (document.activeElement !== els.timeoutInput) {
    els.timeoutInput.value = String(settings.timeoutMinutes);
    updateTimeoutPreview(settings.timeoutMinutes);
    els.timeoutError.hidden = true;
  }

  for (const chip of els.presetChips) {
    const mins = Number(chip.dataset.minutes);
    chip.classList.toggle('active', mins === settings.timeoutMinutes);
  }

  els.protectPinnedToggle.checked = settings.protectPinned;
  els.protectAudibleToggle.checked = settings.protectAudible;
  els.protectBgActiveToggle.checked = settings.protectBackgroundActive;

  // Excluded domains count & current site quick-exclude
  els.excludedCount.textContent = String(settings.excludedDomains.length);

  const currentHost = extractHostname(currentTab?.url || '');
  const alreadyExcluded =
    currentHost && settings.excludedDomains.includes(currentHost);
  if (currentHost && !alreadyExcluded) {
    els.excludeCurrentBtn.textContent = `+ ${currentHost}`;
    els.excludeCurrentBtn.dataset.domain = currentHost;
    els.excludeCurrentBtn.hidden = false;
  } else {
    els.excludeCurrentBtn.hidden = true;
    delete els.excludeCurrentBtn.dataset.domain;
  }

  // Excluded domains chips
  els.excludedList.replaceChildren();
  els.excludedEmpty.hidden = settings.excludedDomains.length > 0;
  for (const domain of settings.excludedDomains) {
    const li = document.createElement('li');
    li.className = 'domain-chip';

    const span = document.createElement('span');
    span.textContent = domain;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'chip-remove';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove ${domain}`;
    removeBtn.setAttribute('aria-label', `Remove ${domain}`);
    removeBtn.addEventListener('click', () => removeExcludedDomain(domain));

    li.append(span, removeBtn);
    els.excludedList.append(li);
  }

  els.totalClosedStat.textContent = `${totalClosedCount} closed`;
}

function renderOpenTabs(state) {
  const { tabStatuses, settings } = state;
  els.openCountBadge.textContent = String(tabStatuses.length);
  els.openTabsList.replaceChildren();
  els.openTabsEmpty.hidden = tabStatuses.length > 0;

  for (const tab of tabStatuses) {
    const row = document.createElement('div');
    row.className = 'tab-row';

    const main = document.createElement('div');
    main.className = 'tab-main';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || 'Untitled tab';
    title.title = tab.title || tab.url;

    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    const host = extractHostname(tab.url) || tab.url || 'Browser tab';
    meta.textContent = host;

    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'tab-actions';

    const status = document.createElement('span');
    status.className = 'status-label';

    if (tab.protectionReason) {
      status.classList.add('status-protected');
      status.textContent =
        PROTECTION_LABELS[tab.protectionReason] || 'Protected';
      actions.append(status);
    } else {
      if (!settings.enabled) {
        status.classList.add('status-countdown');
        status.textContent = `Idle ${formatDuration(tab.inactiveMs)}`;
      } else if (tab.remainingMs <= 0) {
        status.classList.add('status-soon');
        status.textContent = 'Soon';
      } else {
        const isSoon = tab.remainingMs <= 10 * 60 * 1000;
        status.classList.add(isSoon ? 'status-soon' : 'status-countdown');
        status.textContent = `${formatDuration(tab.remainingMs)} left`;
      }

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'row-action';
      resetBtn.textContent = 'Reset';
      resetBtn.title = 'Reset inactivity timer for this tab';
      resetBtn.addEventListener('click', () => handleResetTabTimer(tab.id));

      actions.append(status, resetBtn);
    }

    row.append(main, actions);
    els.openTabsList.append(row);
  }
}

function renderClosedHistory(state) {
  const { closedHistory, now } = state;
  els.closedCountBadge.textContent = String(closedHistory.length);
  els.closedToolbar.hidden = closedHistory.length === 0;
  els.closedHistoryEmpty.hidden = closedHistory.length > 0;
  els.closedHistoryList.replaceChildren();

  closedHistory.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'tab-row';

    const main = document.createElement('div');
    main.className = 'tab-main';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = entry.title || entry.url;
    title.title = entry.url;

    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    const host = extractHostname(entry.url) || entry.url;
    const agoMs = Math.max(0, (now || Date.now()) - (entry.closedAt || 0));
    meta.textContent = `${host} · ${formatDuration(agoMs)} ago`;

    main.append(title, meta);

    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'row-action';
    reopenBtn.textContent = 'Reopen';
    reopenBtn.addEventListener('click', () => handleReopenClosed(index));

    row.append(main, reopenBtn);
    els.closedHistoryList.append(row);
  });
}

function renderAll(state) {
  appState = state;
  if (
    !document.documentElement.dataset.theme &&
    (state.settings.theme === 'light' || state.settings.theme === 'dark')
  ) {
    applyTheme(state.settings.theme);
  }
  renderHeader(state.settings);
  renderTimerPanel(state);
  renderOpenTabs(state);
  renderClosedHistory(state);
}

async function refreshState() {
  try {
    const state = await sendMessage({ type: 'GET_STATE' });
    renderAll(state);
  } catch (err) {
    els.statusSubtitle.textContent = `Error: ${err.message}`;
  }
}

async function updateSettings(partial, toastMessage) {
  try {
    await sendMessage({ type: 'UPDATE_SETTINGS', payload: partial });
    await refreshState();
    if (toastMessage) {
      showToast(toastMessage);
    }
  } catch (err) {
    showToast(`Failed: ${err.message}`);
  }
}

async function addExcludedDomain(rawInput) {
  const domain = normalizeDomain(rawInput);
  if (!domain) {
    els.excludeError.textContent = 'Enter a valid domain (e.g. example.com).';
    els.excludeError.hidden = false;
    return;
  }
  els.excludeError.hidden = true;

  const existing = appState?.settings?.excludedDomains || [];
  if (existing.includes(domain)) {
    els.excludeInput.value = '';
    showToast(`${domain} already excluded`);
    return;
  }

  els.excludeInput.value = '';
  await updateSettings(
    { excludedDomains: [...existing, domain] },
    `Excluded ${domain}`
  );
}

async function removeExcludedDomain(domain) {
  const existing = appState?.settings?.excludedDomains || [];
  const next = existing.filter((d) => d !== domain);
  await updateSettings({ excludedDomains: next }, `Removed ${domain}`);
}

async function handleResetTabTimer(tabId) {
  try {
    await sendMessage({ type: 'RESET_TAB_TIMER', tabId });
    await refreshState();
    showToast('Timer reset');
  } catch (err) {
    showToast(`Failed: ${err.message}`);
  }
}

async function handleReopenClosed(index) {
  try {
    await sendMessage({ type: 'REOPEN_CLOSED_TAB', index });
    await refreshState();
    showToast('Tab reopened');
  } catch (err) {
    showToast(`Failed: ${err.message}`);
  }
}

// Event wiring
for (const btn of els.tabButtons) {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
}

els.themeToggleBtn.addEventListener('click', () => {
  const nextTheme = isCurrentlyDark() ? 'light' : 'dark';
  persistTheme(nextTheme);
});

els.enabledToggle.addEventListener('change', () => {
  const enabled = els.enabledToggle.checked;
  updateSettings({ enabled }, enabled ? 'Enabled' : 'Paused');
});

els.timeoutInput.addEventListener('input', () => {
  els.timeoutError.hidden = true;
  updateTimeoutPreview(els.timeoutInput.value);
});

els.timeoutForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const parsed = parseTimeoutMinutes(els.timeoutInput.value);
  if (parsed === null) {
    els.timeoutError.textContent = `Enter a value between ${MIN_TIMEOUT_MINUTES} and ${MAX_TIMEOUT_MINUTES} minutes.`;
    els.timeoutError.hidden = false;
    return;
  }
  els.timeoutError.hidden = true;
  els.timeoutInput.blur();
  updateSettings(
    { timeoutMinutes: parsed },
    `Timer set to ${formatDuration(parsed * 60 * 1000)}`
  );
});

for (const chip of els.presetChips) {
  chip.addEventListener('click', () => {
    const minutes = Number(chip.dataset.minutes);
    els.timeoutInput.value = String(minutes);
    updateSettings(
      { timeoutMinutes: minutes },
      `Timer set to ${formatDuration(minutes * 60 * 1000)}`
    );
  });
}

els.protectPinnedToggle.addEventListener('change', () => {
  updateSettings({ protectPinned: els.protectPinnedToggle.checked });
});

els.protectAudibleToggle.addEventListener('change', () => {
  updateSettings({ protectAudible: els.protectAudibleToggle.checked });
});

els.protectBgActiveToggle.addEventListener('change', () => {
  updateSettings({
    protectBackgroundActive: els.protectBgActiveToggle.checked,
  });
});

els.excludeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  addExcludedDomain(els.excludeInput.value);
});

els.excludeCurrentBtn.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const domain = els.excludeCurrentBtn.dataset.domain;
  if (domain) {
    addExcludedDomain(domain);
  }
});

els.sweepNowBtn.addEventListener('click', async () => {
  try {
    const res = await sendMessage({ type: 'RUN_SWEEP_NOW' });
    await refreshState();
    if (res.closedCount > 0) {
      const label = res.closedCount === 1 ? 'tab' : 'tabs';
      showToast(`Closed ${res.closedCount} ${label}`);
    } else {
      showToast('All quiet — nothing to close');
    }
  } catch (err) {
    showToast(`Failed: ${err.message}`);
  }
});

els.clearHistoryBtn.addEventListener('click', async () => {
  try {
    await sendMessage({ type: 'CLEAR_HISTORY' });
    await refreshState();
    showToast('History cleared');
  } catch (err) {
    showToast(`Failed: ${err.message}`);
  }
});

// Initial load & live countdown refresh while popup is open
refreshState();
setInterval(refreshState, 15000);
