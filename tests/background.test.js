import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/background.js';
import { SWEEP_ALARM_NAME } from '../src/core.js';

const MIN = 60 * 1000;

function createMockChrome({ tabs = [], windows = [] } = {}) {
  const syncStore = {};
  const localStore = {};
  const alarms = new Map();
  let badgeText = '';
  let badgeColor = '';
  let nextTabId = 100;

  let currentTabs = tabs.map((t) => ({ ...t }));
  let currentWindows = windows.map((w) => ({ ...w }));

  function makeStorage(backing) {
    return {
      async get(keys) {
        if (typeof keys === 'string') {
          return { [keys]: backing[keys] };
        }
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) {
            out[k] = backing[k];
          }
          return out;
        }
        return { ...backing };
      },
      async set(items) {
        Object.assign(backing, items);
      },
    };
  }

  const chromeApi = {
    storage: {
      sync: makeStorage(syncStore),
      local: makeStorage(localStore),
      onChanged: { addListener() {} },
    },
    tabs: {
      async query(filter = {}) {
        return currentTabs.filter((t) => {
          if (filter.windowId !== undefined && t.windowId !== filter.windowId) {
            return false;
          }
          if (filter.active !== undefined && t.active !== filter.active) {
            return false;
          }
          return true;
        });
      },
      async remove(tabId) {
        const idx = currentTabs.findIndex((t) => t.id === tabId);
        if (idx === -1) {
          throw new Error(`No tab with id: ${tabId}`);
        }
        currentTabs.splice(idx, 1);
      },
      async create(props) {
        const tab = {
          id: nextTabId++,
          windowId: currentWindows[0]?.id ?? 1,
          active: true,
          pinned: false,
          audible: false,
          title: props.url,
          url: props.url,
        };
        currentTabs.push(tab);
        return tab;
      },
      onCreated: { addListener() {} },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async getAll() {
        return currentWindows.map((w) => ({ ...w }));
      },
      onFocusChanged: { addListener() {} },
    },
    alarms: {
      async get(name) {
        return alarms.get(name);
      },
      create(name, info) {
        alarms.set(name, { name, ...info });
      },
      onAlarm: { addListener() {} },
    },
    action: {
      async setBadgeText({ text }) {
        badgeText = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badgeColor = color;
      },
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
    },
  };

  return {
    chromeApi,
    getTabs: () => currentTabs,
    setWindows: (next) => {
      currentWindows = next.map((w) => ({ ...w }));
    },
    setTabActive: (windowId, tabId) => {
      currentTabs = currentTabs.map((t) =>
        t.windowId === windowId ? { ...t, active: t.id === tabId } : t
      );
    },
    getBadge: () => ({ text: badgeText, color: badgeColor }),
    getAlarm: (name) => alarms.get(name),
    getLocalStore: () => localStore,
  };
}

test('service worker initializes default 120m timer, alarm, and closes idle tabs and background app windows', async () => {
  let clock = 1_700_000_000_000;
  const mock = createMockChrome({
    windows: [
      { id: 1, focused: true },
      { id: 2, focused: false }, // e.g., standalone Chrome PWA/app window
    ],
    tabs: [
      { id: 1, windowId: 1, active: true, pinned: false, audible: false, url: 'https://docs.example.com', title: 'Docs' },
      { id: 2, windowId: 1, active: false, pinned: false, audible: false, url: 'https://news.example.com', title: 'News' },
      { id: 3, windowId: 2, active: true, pinned: false, audible: false, url: 'https://chat.example.com', title: 'Chat App' },
    ],
  });

  const controller = createController(mock.chromeApi, () => clock);
  await controller.handleInstalled();

  // Default settings & alarm initialized
  const settings = await controller.getSettings();
  assert.equal(settings.timeoutMinutes, 120);
  assert.equal(settings.enabled, true);
  assert.ok(mock.getAlarm(SWEEP_ALARM_NAME));
  assert.equal(mock.getBadge().text, '');

  // Simulate background page update on tab 2 at t=60m -> must NOT reset its inactivity timer
  clock += 60 * MIN;
  await controller.handleTabUpdated(2, { status: 'loading' }, mock.getTabs()[1]);

  // At t=119m, nothing should close yet
  clock += 59 * MIN;
  let sweep = await controller.sweepInactiveTabs();
  assert.equal(sweep.closedCount, 0);
  assert.equal(mock.getTabs().length, 3);

  // At t=120m, Tab 2 (background tab) and Tab 3 (idle background PWA app window) close; Tab 1 stays open
  clock += 1 * MIN;
  sweep = await controller.sweepInactiveTabs();
  assert.equal(sweep.closedCount, 2);
  assert.deepEqual(
    mock.getTabs().map((t) => t.id),
    [1]
  );

  // Closed history recorded and reopenable
  const popupState = await controller.getStateForPopup();
  assert.equal(popupState.totalClosedCount, 2);
  assert.equal(popupState.closedHistory.length, 2);

  await controller.reopenClosedTab(0);
  assert.equal(mock.getTabs().length, 2);
  const afterReopen = await controller.getStateForPopup();
  assert.equal(afterReopen.closedHistory.length, 1);
});

test('switching away from a long-active tab starts its inactivity timer from the switch moment', async () => {
  let clock = 1_700_000_000_000;
  const mock = createMockChrome({
    windows: [{ id: 1, focused: true }],
    tabs: [
      { id: 1, windowId: 1, active: true, pinned: false, audible: false, url: 'https://work.example.com', title: 'Work' },
      { id: 2, windowId: 1, active: false, pinned: false, audible: false, url: 'https://ref.example.com', title: 'Ref' },
    ],
  });

  const controller = createController(mock.chromeApi, () => clock);
  await controller.handleInstalled();

  // User stays on Tab 1 for 150 minutes without a sweep in between, then switches to Tab 2
  clock += 150 * MIN;
  mock.setTabActive(1, 2);
  await controller.handleTabActivated({ tabId: 2, windowId: 1 });

  // Immediate sweep must NOT close Tab 1 (it was just left 0m ago!)
  let sweep = await controller.sweepInactiveTabs();
  assert.equal(sweep.closedCount, 0);

  // 120 minutes later, Tab 1 finally closes
  clock += 120 * MIN;
  sweep = await controller.sweepInactiveTabs();
  assert.equal(sweep.closedCount, 1);
  assert.deepEqual(
    mock.getTabs().map((t) => t.id),
    [2]
  );
});

test('pause toggle updates badge to OFF and prevents closing; resetTabTimer extends a tab', async () => {
  let clock = 1_700_000_000_000;
  const mock = createMockChrome({
    windows: [{ id: 1, focused: true }],
    tabs: [
      { id: 1, windowId: 1, active: true, pinned: false, audible: false, url: 'https://a.example.com', title: 'A' },
      { id: 2, windowId: 1, active: false, pinned: false, audible: false, url: 'https://b.example.com', title: 'B' },
    ],
  });

  const controller = createController(mock.chromeApi, () => clock);
  await controller.handleInstalled();

  // Pause extension
  await controller.handleMessage({
    type: 'UPDATE_SETTINGS',
    payload: { enabled: false },
  });
  assert.equal(mock.getBadge().text, 'OFF');

  clock += 200 * MIN;
  let sweep = await controller.sweepInactiveTabs();
  assert.equal(sweep.closedCount, 0);

  // Reset Tab 2 timer and re-enable
  await controller.handleMessage({ type: 'RESET_TAB_TIMER', tabId: 2 });
  await controller.handleMessage({
    type: 'UPDATE_SETTINGS',
    payload: { enabled: true },
  });
  assert.equal(mock.getBadge().text, '');

  // Should NOT close right after reset
  sweep = await controller.sweepInactiveTabs();
  assert.equal(sweep.closedCount, 0);
  assert.equal(mock.getTabs().length, 2);
});

test('window focus changes stamp the left window active tab so background app windows expire accurately', async () => {
  let clock = 1_700_000_000_000;
  const mock = createMockChrome({
    windows: [
      { id: 1, focused: true },
      { id: 2, focused: false },
    ],
    tabs: [
      { id: 1, windowId: 1, active: true, pinned: false, audible: false, url: 'https://main.example.com', title: 'Main' },
      { id: 2, windowId: 2, active: true, pinned: false, audible: false, url: 'https://pwa.example.com', title: 'PWA App' },
    ],
  });

  const controller = createController(mock.chromeApi, () => clock);
  await controller.handleInstalled();

  // Work in Window 1 for 100m, then switch focus to Window 2 (PWA App)
  clock += 100 * MIN;
  mock.setWindows([
    { id: 1, focused: false },
    { id: 2, focused: true },
  ]);
  await controller.handleWindowFocusChanged(2);

  // Immediately after switching to Window 2, Window 1's active tab should NOT expire
  let sweep = await controller.sweepInactiveTabs();
  assert.equal(sweep.closedCount, 0);

  // 119m later, Window 1 is still 1m shy of 120m
  clock += 119 * MIN;
  sweep = await controller.sweepInactiveTabs();
  assert.equal(sweep.closedCount, 0);

  // 1m later (120m since leaving Window 1), Window 1's tab closes while focused Window 2 stays open
  clock += 1 * MIN;
  sweep = await controller.sweepInactiveTabs();
  assert.equal(sweep.closedCount, 1);
  assert.deepEqual(
    mock.getTabs().map((t) => t.id),
    [2]
  );
});

