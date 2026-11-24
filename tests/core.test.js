import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  evaluateTabsForClosure,
  extractHostname,
  formatDuration,
  isDomainExcluded,
  normalizeDomain,
  normalizeSettings,
  parseTimeoutMinutes,
} from '../src/core.js';

const MIN = 60 * 1000;

test('DEFAULT_SETTINGS defaults to 120 minutes and enabled', () => {
  assert.equal(DEFAULT_TIMEOUT_MINUTES, 120);
  assert.equal(DEFAULT_SETTINGS.timeoutMinutes, 120);
  assert.equal(DEFAULT_SETTINGS.enabled, true);
  assert.equal(DEFAULT_SETTINGS.protectPinned, true);
  assert.equal(DEFAULT_SETTINGS.protectAudible, true);
  assert.equal(DEFAULT_SETTINGS.protectBackgroundActive, false);
  assert.deepEqual(DEFAULT_SETTINGS.excludedDomains, []);
  assert.equal(DEFAULT_SETTINGS.theme, "system");
});

test('parseTimeoutMinutes validates and clamps values', () => {
  assert.equal(parseTimeoutMinutes(120), 120);
  assert.equal(parseTimeoutMinutes('45'), 45);
  assert.equal(parseTimeoutMinutes(1.6), 2);
  assert.equal(parseTimeoutMinutes(0), null);
  assert.equal(parseTimeoutMinutes(-5), null);
  assert.equal(parseTimeoutMinutes('abc'), null);
  assert.equal(parseTimeoutMinutes(MAX_TIMEOUT_MINUTES + 500), MAX_TIMEOUT_MINUTES);
});

test('normalizeDomain parses domains, URLs, and wildcards cleanly', () => {
  assert.equal(normalizeDomain('Example.COM'), 'example.com');
  assert.equal(normalizeDomain('https://mail.google.com/mail/u/0/#inbox'), 'mail.google.com');
  assert.equal(normalizeDomain('*.slack.com'), 'slack.com');
  assert.equal(normalizeDomain('  localhost:3000/app  '), 'localhost');
  assert.equal(normalizeDomain('chrome://extensions'), '');
  assert.equal(normalizeDomain(''), '');
  assert.equal(normalizeDomain('not a domain'), '');
});

test('normalizeSettings merges defaults and deduplicates excluded domains', () => {
  const normalized = normalizeSettings({
    timeoutMinutes: 'invalid',
    protectPinned: false,
    excludedDomains: ['https://Mail.Google.com/inbox', 'mail.google.com', 'bad domain'],
  });
  assert.equal(normalized.timeoutMinutes, 120);
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.protectPinned, false);
  assert.equal(normalized.protectAudible, true);
  assert.deepEqual(normalized.excludedDomains, ['mail.google.com']);
  assert.equal(normalized.theme, "system");
  assert.equal(normalizeSettings({ theme: "dark" }).theme, "dark");
  assert.equal(normalizeSettings({ theme: "light" }).theme, "light");
  assert.equal(normalizeSettings({ theme: "sepia" }).theme, "system");
});

test('isDomainExcluded matches exact domains and subdomains without false positives', () => {
  assert.equal(extractHostname('https://app.linear.app/team'), 'app.linear.app');
  assert.equal(extractHostname('chrome://settings'), '');

  assert.equal(isDomainExcluded('https://linear.app/inbox', ['linear.app']), true);
  assert.equal(isDomainExcluded('https://app.linear.app/inbox', ['linear.app']), true);
  assert.equal(isDomainExcluded('https://notlinear.app/', ['linear.app']), false);
  assert.equal(isDomainExcluded('chrome://extensions', ['extensions']), false);
});

test('evaluateTabsForClosure closes tabs at or past 120m and respects focused/unfocused windows', () => {
  const now = 1_000_000_000;
  const tabs = [
    // Active tab in focused window -> protected & timestamp refreshed
    { id: 1, windowId: 10, active: true, pinned: false, audible: false, url: 'https://focused.example.com', title: 'Focused' },
    // Inactive 119m -> NOT closed yet
    { id: 2, windowId: 10, active: false, pinned: false, audible: false, url: 'https://almost.example.com', title: 'Almost' },
    // Inactive 120m -> CLOSED
    { id: 3, windowId: 10, active: false, pinned: false, audible: false, url: 'https://expired.example.com', title: 'Expired' },
    // Active tab in UNFOCUSED window (e.g., Chrome PWA/app window) inactive 130m -> CLOSED by default
    { id: 4, windowId: 20, active: true, pinned: false, audible: false, url: 'https://pwa.example.com', title: 'Idle App' },
    // Pinned tab inactive 200m -> protected
    { id: 5, windowId: 10, active: false, pinned: true, audible: false, url: 'https://pinned.example.com', title: 'Pinned' },
    // Audible tab inactive 200m -> protected
    { id: 6, windowId: 10, active: false, pinned: false, audible: true, url: 'https://music.example.com', title: 'Music' },
    // Excluded domain inactive 200m -> protected
    { id: 7, windowId: 10, active: false, pinned: false, audible: false, url: 'https://mail.google.com/mail', title: 'Gmail' },
    // Newly seen tab (no prior timestamp) -> seeded to now, not closed
    { id: 8, windowId: 10, active: false, pinned: false, audible: false, url: 'https://new.example.com', title: 'New' },
  ];

  const tabLastActive = {
    '1': now - 300 * MIN,
    '2': now - 119 * MIN,
    '3': now - 120 * MIN,
    '4': now - 130 * MIN,
    '5': now - 200 * MIN,
    '6': now - 200 * MIN,
    '7': now - 200 * MIN,
    '999': now - 500 * MIN, // stale closed tab ID should be pruned
  };

  const result = evaluateTabsForClosure({
    tabs,
    tabLastActive,
    settings: { ...DEFAULT_SETTINGS, excludedDomains: ['mail.google.com'] },
    focusedWindowIds: new Set([10]),
    now,
  });

  assert.deepEqual(
    result.tabsToClose.map((t) => t.id),
    [3, 4]
  );
  assert.equal(result.updatedTimestamps['1'], now);
  assert.equal(result.updatedTimestamps['8'], now);
  assert.equal('999' in result.updatedTimestamps, false);

  // Verify sorting puts unprotected tabs closest to closing first
  assert.equal(result.tabStatuses[0].id, 3);
  assert.equal(result.tabStatuses[1].id, 4);
  assert.equal(result.tabStatuses[2].id, 2);
});

test('evaluateTabsForClosure respects protectBackgroundActive and enabled=false', () => {
  const now = 1_000_000_000;
  const tabs = [
    { id: 1, windowId: 20, active: true, pinned: false, audible: false, url: 'https://pwa.example.com', title: 'Idle App' },
    { id: 2, windowId: 10, active: false, pinned: false, audible: false, url: 'https://old.example.com', title: 'Old Tab' },
  ];
  const tabLastActive = {
    '1': now - 180 * MIN,
    '2': now - 180 * MIN,
  };

  const withBgProtected = evaluateTabsForClosure({
    tabs,
    tabLastActive,
    settings: { ...DEFAULT_SETTINGS, protectBackgroundActive: true },
    focusedWindowIds: new Set([10]),
    now,
  });
  assert.deepEqual(withBgProtected.tabsToClose.map((t) => t.id), [2]);

  const whenPaused = evaluateTabsForClosure({
    tabs,
    tabLastActive,
    settings: { ...DEFAULT_SETTINGS, enabled: false },
    focusedWindowIds: new Set([10]),
    now,
  });
  assert.deepEqual(whenPaused.tabsToClose, []);
});

test('formatDuration produces concise human-readable strings', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(30 * 1000), '< 1m');
  assert.equal(formatDuration(45 * MIN), '45m');
  assert.equal(formatDuration(120 * MIN), '2h');
  assert.equal(formatDuration(135 * MIN), '2h 15m');
  assert.equal(formatDuration(27 * 60 * MIN), '1d 3h');
});
