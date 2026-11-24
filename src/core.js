export const DEFAULT_TIMEOUT_MINUTES = 120;
export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 43200; // 30 days
export const MAX_CLOSED_HISTORY = 30;
export const SWEEP_ALARM_NAME = 'auto-tab-closer-sweep';
export const SWEEP_INTERVAL_MINUTES = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
  protectPinned: true,
  protectAudible: true,
  protectBackgroundActive: false,
  excludedDomains: [],
});

/**
 * Normalizes a user-supplied domain or URL string into a lowercase hostname.
 * Returns an empty string if the input cannot be parsed into a valid hostname.
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string') {
    return '';
  }

  let trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }

  // Strip wildcard prefix like "*.example.com"
  trimmed = trimmed.replace(/^\*\./, '');

  // If it doesn't include a scheme, prepend http:// so URL parsing works reliably
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    const host = parsed.hostname.replace(/\.+$/, '');
    if (!host || /\s/.test(host)) {
      return '';
    }
    return host;
  } catch {
    return '';
  }
}

/**
 * Validates and clamps a timeout value in minutes.
 * Returns null if the value is not a finite positive number.
 */
export function parseTimeoutMinutes(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < MIN_TIMEOUT_MINUTES) {
    return null;
  }
  return Math.min(MAX_TIMEOUT_MINUTES, Math.round(num));
}

/**
 * Merges arbitrary persisted settings with safe defaults.
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const parsedTimeout = parseTimeoutMinutes(source.timeoutMinutes);

  const rawDomains = Array.isArray(source.excludedDomains)
    ? source.excludedDomains
    : [];
  const uniqueDomains = [];
  const seen = new Set();

  for (const item of rawDomains) {
    const domain = normalizeDomain(item);
    if (domain && !seen.has(domain)) {
      seen.add(domain);
      uniqueDomains.push(domain);
    }
  }

  return {
    enabled:
      typeof source.enabled === 'boolean'
        ? source.enabled
        : DEFAULT_SETTINGS.enabled,
    timeoutMinutes:
      parsedTimeout !== null ? parsedTimeout : DEFAULT_SETTINGS.timeoutMinutes,
    protectPinned:
      typeof source.protectPinned === 'boolean'
        ? source.protectPinned
        : DEFAULT_SETTINGS.protectPinned,
    protectAudible:
      typeof source.protectAudible === 'boolean'
        ? source.protectAudible
        : DEFAULT_SETTINGS.protectAudible,
    protectBackgroundActive:
      typeof source.protectBackgroundActive === 'boolean'
        ? source.protectBackgroundActive
        : DEFAULT_SETTINGS.protectBackgroundActive,
    excludedDomains: uniqueDomains,
  };
}

/**
 * Extracts a lowercase hostname from an HTTP(S) URL, or returns ''.
 */
export function extractHostname(url) {
  if (typeof url !== 'string' || !url) {
    return '';
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Checks whether a tab's URL matches any domain in the exclusion list.
 * Matches exact domain or any subdomain (e.g. "google.com" matches "mail.google.com").
 */
export function isDomainExcluded(url, excludedDomains) {
  if (!Array.isArray(excludedDomains) || excludedDomains.length === 0) {
    return false;
  }
  const hostname = extractHostname(url);
  if (!hostname) {
    return false;
  }

  return excludedDomains.some((rawDomain) => {
    const domain = normalizeDomain(rawDomain);
    if (!domain) {
      return false;
    }
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
}

/**
 * Returns the reason a tab is protected from auto-closing, or null if eligible.
 */
export function getTabProtectionReason(tab, settings, focusedWindowIds) {
  const isFocusedWindow =
    focusedWindowIds instanceof Set
      ? focusedWindowIds.has(tab.windowId)
      : false;

  if (tab.active && isFocusedWindow) {
    return 'active';
  }
  if (settings.protectBackgroundActive && tab.active) {
    return 'background-active';
  }
  if (settings.protectPinned && tab.pinned) {
    return 'pinned';
  }
  if (settings.protectAudible && tab.audible) {
    return 'audible';
  }
  const tabUrl = tab.url || tab.pendingUrl || '';
  if (isDomainExcluded(tabUrl, settings.excludedDomains)) {
    return 'excluded';
  }
  return null;
}

/**
 * Evaluates all open tabs against the inactivity timer and protection rules.
 *
 * Returns:
 * - tabsToClose: array of tab objects that should be closed right now
 * - updatedTimestamps: pruned & refreshed map of { [tabId]: lastActiveMs }
 * - tabStatuses: sorted UI-ready status array for every open tab
 */
export function evaluateTabsForClosure({
  tabs,
  tabLastActive,
  settings,
  focusedWindowIds,
  now,
}) {
  const normalized = normalizeSettings(settings);
  const timeoutMs = normalized.timeoutMinutes * 60 * 1000;
  const timestamps =
    tabLastActive && typeof tabLastActive === 'object' ? tabLastActive : {};
  const focusedSet =
    focusedWindowIds instanceof Set
      ? focusedWindowIds
      : new Set(focusedWindowIds || []);

  const tabsToClose = [];
  const updatedTimestamps = {};
  const tabStatuses = [];

  for (const tab of tabs) {
    if (typeof tab?.id !== 'number') {
      continue;
    }
    const key = String(tab.id);
    const protectionReason = getTabProtectionReason(tab, normalized, focusedSet);

    let lastActive;
    if (protectionReason === 'active') {
      lastActive = now;
    } else if (
      typeof timestamps[key] === 'number' &&
      Number.isFinite(timestamps[key]) &&
      timestamps[key] <= now
    ) {
      lastActive = timestamps[key];
    } else {
      lastActive = now;
    }

    updatedTimestamps[key] = lastActive;

    const inactiveMs = Math.max(0, now - lastActive);
    const remainingMs = Math.max(0, timeoutMs - inactiveMs);
    const shouldClose = Boolean(
      normalized.enabled && !protectionReason && inactiveMs >= timeoutMs
    );

    if (shouldClose) {
      tabsToClose.push(tab);
    }

    tabStatuses.push({
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || tab.url || 'Untitled tab',
      url: tab.url || tab.pendingUrl || '',
      favIconUrl: tab.favIconUrl || '',
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      audible: Boolean(tab.audible),
      lastActive,
      inactiveMs,
      remainingMs,
      protectionReason,
      shouldClose,
    });
  }

  tabStatuses.sort((a, b) => {
    const aProtected = Boolean(a.protectionReason);
    const bProtected = Boolean(b.protectionReason);
    if (aProtected !== bProtected) {
      return aProtected ? 1 : -1;
    }
    if (!aProtected) {
      return a.remainingMs - b.remainingMs;
    }
    if (a.protectionReason === 'active' && b.protectionReason !== 'active') {
      return -1;
    }
    if (b.protectionReason === 'active' && a.protectionReason !== 'active') {
      return 1;
    }
    return b.inactiveMs - a.inactiveMs;
  });

  return {
    tabsToClose,
    updatedTimestamps,
    tabStatuses,
  };
}

/**
 * Formats a duration in milliseconds as a concise human-readable string.
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0m';
  }
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) {
    return '< 1m';
  }
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (totalHours < 24) {
    return mins > 0 ? `${totalHours}h ${mins}m` : `${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}
