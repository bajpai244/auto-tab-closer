import {
  MAX_TIMEOUT_MINUTES,
  MIN_TIMEOUT_MINUTES,
  extractHostname,
  formatDuration,
  normalizeDomain,
  parseTimeoutMinutes,
} from './core.js';

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
  statusSubtitle: document.getElementById('statusSubtitle'),
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
  timeoutFormatted: document.getElementById('timeoutFormatted'),
  timeoutError: document.getElementById('timeoutError'),
  presetChips: Array.from(document.querySelectorAll('.preset-chip')),
  protectPinnedToggle: document.getElementById('protectPinnedToggle'),
  protectAudibleToggle: document.getElementById('protectAudibleToggle'),
  protectBgActiveToggle: document.getElementById('protectBgActiveToggle'),
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
  }, 2200);
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
    els.timeoutFormatted.textContent = 'Invalid';
    return;
  }
  els.timeoutFormatted.textContent = formatDuration(parsed * 60 * 1000);
}

function renderHeader(settings) {
  els.enabledToggle.checked = settings.enabled;
  if (settings.enabled) {
    const formatted = formatDuration(settings.timeoutMinutes * 60 * 1000);
    els.statusSubtitle.textContent = `Closing inactive tabs after ${formatted}`;
  } else {
    els.statusSubtitle.textContent = 'Paused — tabs will not auto-close';
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

  // Current site quick-exclude button
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

  const label = totalClosedCount === 1 ? 'tab' : 'tabs';
  els.totalClosedStat.textContent = `${totalClosedCount} ${label} auto-closed`;
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

    const badge = document.createElement('span');
    badge.className = 'badge';

    if (tab.protectionReason) {
      badge.classList.add('badge-protected');
      badge.textContent =
        PROTECTION_LABELS[tab.protectionReason] || 'Protected';
      actions.append(badge);
    } else {
      if (!settings.enabled) {
        badge.classList.add('badge-countdown');
        badge.textContent = `Idle ${formatDuration(tab.inactiveMs)}`;
      } else if (tab.remainingMs <= 0) {
        badge.classList.add('badge-soon');
        badge.textContent = 'Closing soon';
      } else {
        const isSoon = tab.remainingMs <= 10 * 60 * 1000;
        badge.classList.add(isSoon ? 'badge-soon' : 'badge-countdown');
        badge.textContent = `In ${formatDuration(tab.remainingMs)}`;
      }

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'btn btn-secondary btn-sm';
      resetBtn.textContent = 'Reset';
      resetBtn.title = 'Reset inactivity timer for this tab';
      resetBtn.addEventListener('click', () => handleResetTabTimer(tab.id));

      actions.append(badge, resetBtn);
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
    meta.textContent = `${host} · closed ${formatDuration(agoMs)} ago`;

    main.append(title, meta);

    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'btn btn-secondary btn-sm';
    reopenBtn.textContent = 'Reopen';
    reopenBtn.addEventListener('click', () => handleReopenClosed(index));

    row.append(main, reopenBtn);
    els.closedHistoryList.append(row);
  });
}

function renderAll(state) {
  appState = state;
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
    showToast(`${domain} is already excluded`);
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
    showToast('Tab timer reset');
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

els.enabledToggle.addEventListener('change', () => {
  const enabled = els.enabledToggle.checked;
  updateSettings({ enabled }, enabled ? 'Auto-closing enabled' : 'Auto-closing paused');
});

els.timeoutInput.addEventListener('input', () => {
  els.timeoutError.hidden = true;
  updateTimeoutPreview(els.timeoutInput.value);
});

els.timeoutForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const parsed = parseTimeoutMinutes(els.timeoutInput.value);
  if (parsed === null) {
    els.timeoutError.textContent = `Enter a duration between ${MIN_TIMEOUT_MINUTES} and ${MAX_TIMEOUT_MINUTES} minutes.`;
    els.timeoutError.hidden = false;
    return;
  }
  els.timeoutError.hidden = true;
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

els.excludeCurrentBtn.addEventListener('click', () => {
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
      showToast(`Closed ${res.closedCount} inactive ${label}`);
    } else {
      showToast('No inactive tabs due to close');
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
