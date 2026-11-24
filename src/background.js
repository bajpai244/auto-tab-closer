import {
  DEFAULT_SETTINGS,
  MAX_CLOSED_HISTORY,
  SWEEP_ALARM_NAME,
  SWEEP_INTERVAL_MINUTES,
  evaluateTabsForClosure,
  normalizeSettings,
} from './core.js';

const WINDOW_ID_NONE = -1;

export function createController(chromeApi, now = () => Date.now()) {
  let queue = Promise.resolve();

  function enqueue(task) {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  }

  async function getSettings() {
    const result = await chromeApi.storage.sync.get('settings');
    return normalizeSettings(result?.settings);
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    const next = normalizeSettings({ ...current, ...partial });
    await chromeApi.storage.sync.set({ settings: next });
    await updateBadge(next);
    await ensureAlarm();
    return next;
  }

  async function getLocalState() {
    const data = await chromeApi.storage.local.get([
      'tabLastActive',
      'activeTabByWindow',
      'lastFocusedWindowId',
      'closedHistory',
      'totalClosedCount',
    ]);
    return {
      tabLastActive:
        data?.tabLastActive && typeof data.tabLastActive === 'object'
          ? { ...data.tabLastActive }
          : {},
      activeTabByWindow:
        data?.activeTabByWindow && typeof data.activeTabByWindow === 'object'
          ? { ...data.activeTabByWindow }
          : {},
      lastFocusedWindowId:
        typeof data?.lastFocusedWindowId === 'number'
          ? data.lastFocusedWindowId
          : null,
      closedHistory: Array.isArray(data?.closedHistory)
        ? [...data.closedHistory]
        : [],
      totalClosedCount:
        typeof data?.totalClosedCount === 'number' ? data.totalClosedCount : 0,
    };
  }

  async function updateBadge(settings) {
    if (!chromeApi.action?.setBadgeText) {
      return;
    }
    const resolved = settings || (await getSettings());
    if (!resolved.enabled) {
      await chromeApi.action.setBadgeText({ text: 'OFF' });
      if (chromeApi.action.setBadgeBackgroundColor) {
        await chromeApi.action.setBadgeBackgroundColor({ color: '#57534e' });
      }
    } else {
      await chromeApi.action.setBadgeText({ text: '' });
    }
  }

  async function ensureAlarm() {
    if (!chromeApi.alarms) {
      return;
    }
    const existing = await chromeApi.alarms.get(SWEEP_ALARM_NAME);
    if (!existing) {
      chromeApi.alarms.create(SWEEP_ALARM_NAME, {
        periodInMinutes: SWEEP_INTERVAL_MINUTES,
      });
    }
  }

  async function getFocusedWindowIds() {
    const windows = await chromeApi.windows.getAll({});
    const focused = new Set();
    for (const win of windows) {
      if (win?.focused && typeof win.id === 'number') {
        focused.add(win.id);
      }
    }
    return focused;
  }

  async function syncOpenTabs() {
    return enqueue(async () => {
      const currentTime = now();
      const [tabs, windows, state] = await Promise.all([
        chromeApi.tabs.query({}),
        chromeApi.windows.getAll({}),
        getLocalState(),
      ]);

      const nextTimestamps = {};
      const nextActiveByWindow = {};
      let focusedWinId = null;

      for (const win of windows) {
        if (win?.focused && typeof win.id === 'number') {
          focusedWinId = win.id;
        }
      }

      for (const tab of tabs) {
        if (typeof tab?.id !== 'number') {
          continue;
        }
        const key = String(tab.id);
        const existing = state.tabLastActive[key];
        nextTimestamps[key] =
          typeof existing === 'number' && Number.isFinite(existing)
            ? existing
            : currentTime;

        if (tab.active && typeof tab.windowId === 'number') {
          nextActiveByWindow[String(tab.windowId)] = tab.id;
          if (tab.windowId === focusedWinId) {
            nextTimestamps[key] = currentTime;
          }
        }
      }

      await chromeApi.storage.local.set({
        tabLastActive: nextTimestamps,
        activeTabByWindow: nextActiveByWindow,
        lastFocusedWindowId: focusedWinId,
      });
    });
  }

  async function handleInstalled() {
    const stored = await chromeApi.storage.sync.get('settings');
    if (!stored?.settings) {
      await chromeApi.storage.sync.set({ settings: { ...DEFAULT_SETTINGS } });
    }
    await syncOpenTabs();
    await ensureAlarm();
    await updateBadge();
  }

  async function handleStartup() {
    await syncOpenTabs();
    await ensureAlarm();
    await updateBadge();
  }

  async function handleTabCreated(tab) {
    if (typeof tab?.id !== 'number') {
      return;
    }
    return enqueue(async () => {
      const currentTime = now();
      const state = await getLocalState();
      state.tabLastActive[String(tab.id)] = currentTime;
      if (tab.active && typeof tab.windowId === 'number') {
        state.activeTabByWindow[String(tab.windowId)] = tab.id;
      }
      await chromeApi.storage.local.set({
        tabLastActive: state.tabLastActive,
        activeTabByWindow: state.activeTabByWindow,
      });
    });
  }

  async function handleTabActivated(activeInfo) {
    if (typeof activeInfo?.tabId !== 'number') {
      return;
    }
    return enqueue(async () => {
      const currentTime = now();
      const state = await getLocalState();
      const winKey = String(activeInfo.windowId);
      const prevTabId = state.activeTabByWindow[winKey];

      // Mark the exact moment the user left the previously active tab
      if (typeof prevTabId === 'number' && prevTabId !== activeInfo.tabId) {
        state.tabLastActive[String(prevTabId)] = currentTime;
      }

      state.tabLastActive[String(activeInfo.tabId)] = currentTime;
      state.activeTabByWindow[winKey] = activeInfo.tabId;

      await chromeApi.storage.local.set({
        tabLastActive: state.tabLastActive,
        activeTabByWindow: state.activeTabByWindow,
      });
    });
  }

  async function handleTabUpdated(tabId, changeInfo, tab) {
    if (typeof tabId !== 'number') {
      return;
    }
    const isNavigation = Boolean(changeInfo?.url || changeInfo?.status === 'loading');
    if (!isNavigation) {
      return;
    }
    return enqueue(async () => {
      const currentTime = now();
      const [state, focusedWindowIds] = await Promise.all([
        getLocalState(),
        getFocusedWindowIds(),
      ]);
      const key = String(tabId);
      const isFocusedActive = Boolean(
        tab?.active && focusedWindowIds.has(tab.windowId)
      );

      // Only refresh timestamp on active user navigation (or if tab was untracked)
      if (isFocusedActive || typeof state.tabLastActive[key] !== 'number') {
        state.tabLastActive[key] = currentTime;
        await chromeApi.storage.local.set({
          tabLastActive: state.tabLastActive,
        });
      }
    });
  }

  async function handleTabRemoved(tabId, removeInfo) {
    if (typeof tabId !== 'number') {
      return;
    }
    return enqueue(async () => {
      const state = await getLocalState();
      delete state.tabLastActive[String(tabId)];
      if (typeof removeInfo?.windowId === 'number') {
        const winKey = String(removeInfo.windowId);
        if (state.activeTabByWindow[winKey] === tabId) {
          delete state.activeTabByWindow[winKey];
        }
      }
      await chromeApi.storage.local.set({
        tabLastActive: state.tabLastActive,
        activeTabByWindow: state.activeTabByWindow,
      });
    });
  }

  async function handleWindowFocusChanged(windowId) {
    return enqueue(async () => {
      const currentTime = now();
      const state = await getLocalState();
      const prevWinId = state.lastFocusedWindowId;

      // Record the moment the user stopped viewing the previously focused window's active tab
      if (
        typeof prevWinId === 'number' &&
        prevWinId !== WINDOW_ID_NONE &&
        prevWinId !== windowId
      ) {
        const prevTabId = state.activeTabByWindow[String(prevWinId)];
        if (typeof prevTabId === 'number') {
          state.tabLastActive[String(prevTabId)] = currentTime;
        }
      }

      const noneId =
        chromeApi.windows?.WINDOW_ID_NONE ?? WINDOW_ID_NONE;

      if (typeof windowId === 'number' && windowId !== noneId) {
        try {
          const activeTabs = await chromeApi.tabs.query({
            windowId,
            active: true,
          });
          if (activeTabs?.[0]?.id !== undefined) {
            const activeTabId = activeTabs[0].id;
            state.tabLastActive[String(activeTabId)] = currentTime;
            state.activeTabByWindow[String(windowId)] = activeTabId;
          }
        } catch {
          // Window may have closed before query resolved
        }
        state.lastFocusedWindowId = windowId;
      } else {
        state.lastFocusedWindowId = null;
      }

      await chromeApi.storage.local.set({
        tabLastActive: state.tabLastActive,
        activeTabByWindow: state.activeTabByWindow,
        lastFocusedWindowId: state.lastFocusedWindowId,
      });
    });
  }

  async function sweepInactiveTabs() {
    return enqueue(async () => {
      const currentTime = now();
      const [settings, state, tabs, focusedWindowIds] = await Promise.all([
        getSettings(),
        getLocalState(),
        chromeApi.tabs.query({}),
        getFocusedWindowIds(),
      ]);

      const { tabsToClose, updatedTimestamps } = evaluateTabsForClosure({
        tabs,
        tabLastActive: state.tabLastActive,
        settings,
        focusedWindowIds,
        now: currentTime,
      });

      const closedTabs = [];

      for (const tab of tabsToClose) {
        try {
          await chromeApi.tabs.remove(tab.id);
          delete updatedTimestamps[String(tab.id)];
          if (
            typeof tab.windowId === 'number' &&
            state.activeTabByWindow[String(tab.windowId)] === tab.id
          ) {
            delete state.activeTabByWindow[String(tab.windowId)];
          }
          const tabUrl = tab.url || tab.pendingUrl || '';
          const record = {
            title: tab.title || tabUrl || 'Untitled tab',
            url: tabUrl,
            favIconUrl: tab.favIconUrl || '',
            closedAt: currentTime,
          };
          closedTabs.push(record);
          if (tabUrl && tabUrl !== 'about:blank') {
            state.closedHistory.unshift(record);
          }
        } catch {
          // Tab may have been closed manually between query and remove
          delete updatedTimestamps[String(tab.id)];
        }
      }

      const trimmedHistory = state.closedHistory.slice(0, MAX_CLOSED_HISTORY);
      const totalClosedCount = state.totalClosedCount + closedTabs.length;

      await chromeApi.storage.local.set({
        tabLastActive: updatedTimestamps,
        activeTabByWindow: state.activeTabByWindow,
        closedHistory: trimmedHistory,
        totalClosedCount,
      });

      return {
        closedCount: closedTabs.length,
        closedTabs,
      };
    });
  }

  async function getStateForPopup() {
    return enqueue(async () => {
      const currentTime = now();
      const [settings, state, tabs, focusedWindowIds] = await Promise.all([
        getSettings(),
        getLocalState(),
        chromeApi.tabs.query({}),
        getFocusedWindowIds(),
      ]);

      const { updatedTimestamps, tabStatuses } = evaluateTabsForClosure({
        tabs,
        tabLastActive: state.tabLastActive,
        settings,
        focusedWindowIds,
        now: currentTime,
      });

      await chromeApi.storage.local.set({
        tabLastActive: updatedTimestamps,
      });

      const currentTab =
        tabs.find((t) => t.active && focusedWindowIds.has(t.windowId)) ||
        tabs.find((t) => t.active) ||
        null;

      return {
        settings,
        tabStatuses,
        closedHistory: state.closedHistory,
        totalClosedCount: state.totalClosedCount,
        currentTab: currentTab
          ? {
              id: currentTab.id,
              title: currentTab.title || '',
              url: currentTab.url || currentTab.pendingUrl || '',
            }
          : null,
        now: currentTime,
      };
    });
  }

  async function resetTabTimer(tabId) {
    if (typeof tabId !== 'number') {
      return { ok: false };
    }
    return enqueue(async () => {
      const state = await getLocalState();
      state.tabLastActive[String(tabId)] = now();
      await chromeApi.storage.local.set({
        tabLastActive: state.tabLastActive,
      });
      return { ok: true };
    });
  }

  async function reopenClosedTab(index) {
    return enqueue(async () => {
      const state = await getLocalState();
      const entry = state.closedHistory[index];
      if (!entry?.url) {
        return { ok: false };
      }
      await chromeApi.tabs.create({ url: entry.url });
      state.closedHistory.splice(index, 1);
      await chromeApi.storage.local.set({
        closedHistory: state.closedHistory,
      });
      return { ok: true };
    });
  }

  async function clearClosedHistory() {
    return enqueue(async () => {
      await chromeApi.storage.local.set({ closedHistory: [] });
      return { ok: true };
    });
  }

  async function handleMessage(message) {
    switch (message?.type) {
      case 'GET_STATE':
        return getStateForPopup();
      case 'UPDATE_SETTINGS': {
        const settings = await saveSettings(message.payload || {});
        return { settings };
      }
      case 'RUN_SWEEP_NOW':
        return sweepInactiveTabs();
      case 'RESET_TAB_TIMER':
        return resetTabTimer(message.tabId);
      case 'REOPEN_CLOSED_TAB':
        return reopenClosedTab(message.index);
      case 'CLEAR_HISTORY':
        return clearClosedHistory();
      default:
        return { error: `Unknown message type: ${String(message?.type)}` };
    }
  }

  function registerListeners() {
    chromeApi.runtime.onInstalled.addListener(() => {
      handleInstalled();
    });

    chromeApi.runtime.onStartup.addListener(() => {
      handleStartup();
    });

    chromeApi.tabs.onCreated.addListener((tab) => {
      handleTabCreated(tab);
    });

    chromeApi.tabs.onActivated.addListener((activeInfo) => {
      handleTabActivated(activeInfo);
    });

    chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      handleTabUpdated(tabId, changeInfo, tab);
    });

    chromeApi.tabs.onRemoved.addListener((tabId, removeInfo) => {
      handleTabRemoved(tabId, removeInfo);
    });

    chromeApi.windows.onFocusChanged.addListener((windowId) => {
      handleWindowFocusChanged(windowId);
    });

    chromeApi.alarms.onAlarm.addListener((alarm) => {
      if (alarm?.name === SWEEP_ALARM_NAME) {
        sweepInactiveTabs();
      }
    });

    chromeApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync' && changes.settings) {
        updateBadge(normalizeSettings(changes.settings.newValue));
        ensureAlarm();
      }
    });

    chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      handleMessage(message)
        .then((res) => sendResponse(res))
        .catch((err) =>
          sendResponse({ error: err?.message || 'Unexpected error' })
        );
      return true;
    });

    // Ensure alarm and badge are always initialized when service worker wakes up
    ensureAlarm();
    updateBadge();
  }

  return {
    registerListeners,
    getSettings,
    saveSettings,
    syncOpenTabs,
    handleInstalled,
    handleStartup,
    handleTabCreated,
    handleTabActivated,
    handleTabUpdated,
    handleTabRemoved,
    handleWindowFocusChanged,
    sweepInactiveTabs,
    getStateForPopup,
    resetTabTimer,
    reopenClosedTab,
    clearClosedHistory,
    handleMessage,
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  const controller = createController(chrome);
  controller.registerListeners();
}
