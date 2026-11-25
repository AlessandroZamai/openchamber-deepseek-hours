// Dynamic Chinese public holiday calendar with cache, stale-while-revalidate,
// and a three-source fallback chain. Never throws at the UI.

import { parseCalendar, parseChineseDays } from './schedule.js';

export const CACHE_PREFIX = 'deepseek-hours.calendar.v1.';
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const NOT_PUBLISHED_TTL_MS = 6 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 8000;

const PRIMARY_BASE = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master';
const FALLBACK_BASE = 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master';
const CHINESE_DAYS_BASE = 'https://unpkg.com/chinese-days@2/dist/years';

export function calendarCacheKey(year) {
  return `${CACHE_PREFIX}${year}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function utcStamp(now) {
  const date = new Date(now);
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
}

function primaryUrl(year) {
  return `${PRIMARY_BASE}/${year}.json`;
}

function fallbackUrl(year, now) {
  return `${FALLBACK_BASE}/${year}.json?v=${utcStamp(now)}`;
}

function chineseDaysUrl(year) {
  return `${CHINESE_DAYS_BASE}/${year}.json`;
}

function normalizeNow(value) {
  if (value instanceof Date) return value.getTime();
  return Number.isFinite(value) ? value : Date.now();
}

function isDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeCache(value, year) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.v !== 1 || value.year !== year) return null;
  if (!Array.isArray(value.offDays) || !value.offDays.every(isDateKey)) return null;
  if (!Number.isFinite(value.fetchedAt)) return null;
  return {
    v: 1,
    year,
    offDays: [...new Set(value.offDays)],
    papers: Array.isArray(value.papers)
      ? value.papers.filter((paper) => typeof paper === 'string' && paper.length > 0)
      : [],
    fetchedAt: value.fetchedAt,
    source: typeof value.source === 'string' ? value.source : null,
    dataset: typeof value.dataset === 'string' ? value.dataset : 'holiday-cn',
    notPublished: value.notPublished === true,
  };
}

function isFresh(entry, now) {
  const ttl = entry.notPublished ? NOT_PUBLISHED_TTL_MS : CACHE_TTL_MS;
  return now - entry.fetchedAt < ttl;
}

async function readCache(storage, year) {
  if (!storage || typeof storage.get !== 'function') return null;
  try {
    return normalizeCache(await storage.get(calendarCacheKey(year)), year);
  } catch {
    return null;
  }
}

async function writeCache(storage, year, value) {
  if (!storage || typeof storage.set !== 'function') return;
  try {
    await storage.set(calendarCacheKey(year), value);
  } catch {
    // Cache is best effort; a storage failure must not break the clock.
  }
}

async function requestJson(url, fetchImpl) {
  let controller = null;
  let timer = null;
  try {
    if (typeof AbortController === 'function') controller = new AbortController();
    timer = setTimeout(() => controller?.abort(), FETCH_TIMEOUT_MS);
    const response = await fetchImpl(url, {
      cache: 'no-store',
      signal: controller?.signal,
    });
    if (!response || typeof response.status !== 'number') return { failed: true };
    if (response.status === 404) return { notFound: true };
    if (response.status < 200 || response.status >= 300) return { failed: true };
    return { json: await response.json() };
  } catch {
    return { failed: true };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function holidayCnParser(year) {
  return (json) => {
    const parsed = parseCalendar(json);
    if (parsed.year !== year) throw new TypeError('Calendar year does not match request');
    return parsed;
  };
}

function chineseDaysParser(year) {
  return (json) => parseChineseDays(json, year);
}

/**
 * Try raw holiday-cn, then jsDelivr holiday-cn, then chinese-days on unpkg.
 * A source that 404s, errors, serves invalid JSON, or fails validation is
 * skipped. All three 404s means the year is not published yet.
 */
async function fetchYear({ year, now, fetchImpl }) {
  const sources = [
    { url: primaryUrl(year), dataset: 'holiday-cn', parse: holidayCnParser(year) },
    { url: fallbackUrl(year, now), dataset: 'holiday-cn', parse: holidayCnParser(year) },
    { url: chineseDaysUrl(year), dataset: 'chinese-days', parse: chineseDaysParser(year) },
  ];

  let notFound = 0;
  for (const source of sources) {
    const response = await requestJson(source.url, fetchImpl);
    if (response.notFound) {
      notFound += 1;
      continue;
    }
    if (response.json === undefined) continue;

    let parsed = null;
    try {
      parsed = source.parse(response.json);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    return {
      kind: 'data',
      dataset: source.dataset,
      source: source.url,
      papers: parsed.papers,
      offDays: [...parsed.offDays],
    };
  }

  if (notFound === sources.length) return { kind: 'notPublished' };
  return { kind: 'failed' };
}

async function fetchAndStore(state, { year, now, storage, fetchImpl }) {
  const fetched = await fetchYear({ year, now, fetchImpl });

  if (fetched.kind === 'data') {
    const data = {
      v: 1,
      year,
      offDays: fetched.offDays,
      papers: fetched.papers,
      fetchedAt: now,
      source: fetched.source,
      dataset: fetched.dataset,
    };
    await writeCache(storage, year, data);
    return { year, stale: false, status: 'fetched', data };
  }

  if (fetched.kind === 'notPublished') {
    const data = {
      v: 1,
      year,
      offDays: [],
      papers: [],
      fetchedAt: now,
      source: null,
      dataset: null,
      notPublished: true,
    };
    await writeCache(storage, year, data);
    return { year, stale: false, status: 'notPublished', data };
  }

  if (state.cached) {
    return { year, stale: true, status: 'stale', data: state.cached };
  }
  return { year, stale: false, status: 'missing', data: null };
}

function mergeStates(states, flags = {}) {
  const offDays = new Set();
  const papers = [];
  const entries = [];
  let fetchedAt = null;
  let allKnown = true;

  for (const state of states) {
    const data = state.data;
    if (!data) {
      allKnown = false;
    } else {
      for (const date of data.offDays) offDays.add(date);
      for (const paper of data.papers) {
        if (!papers.includes(paper)) papers.push(paper);
      }
      if (fetchedAt === null && Number.isFinite(data.fetchedAt)) fetchedAt = data.fetchedAt;
    }
    entries.push({
      year: state.year,
      status: state.status,
      stale: state.status === 'stale',
      notPublished: data?.notPublished === true,
      fetchedAt: data?.fetchedAt ?? null,
      source: data?.source ?? null,
      dataset: data?.dataset ?? null,
      papers: data?.papers ?? [],
    });
  }

  return {
    offDays,
    papers,
    entries,
    incomplete: flags.incomplete ?? !allKnown,
    stale: flags.stale ?? states.some((state) => state.status === 'stale'),
    fetchedAt,
    ...(flags.revalidating ? { revalidating: true } : {}),
  };
}

/**
 * Load the requested years. The function always resolves.
 *
 * - Fresh cache: return it without a request.
 * - Expired cache: return it immediately (stale) and refresh in the
 *   background; `onUpdate` receives the refreshed result.
 * - A year with no cache is awaited once; a failure marks the result
 *   incomplete so the UI can fall back to the Mon-Fri rule explicitly.
 * - `force` bypasses the TTL and awaits every source attempt.
 */
export async function loadCalendar(options = {}) {
  const {
    years = [],
    storage = null,
    fetchImpl = null,
    now: rawNow = Date.now(),
    force = false,
    onUpdate = null,
  } = options;

  const now = normalizeNow(rawNow);
  const uniqueYears = [...new Set(years.filter((year) => Number.isInteger(year)))];
  const request = fetchImpl ?? ((url, init) => {
    if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'));
    return fetch(url, init);
  });

  try {
    const states = [];
    for (const year of uniqueYears) {
      const cached = await readCache(storage, year);
      const fresh = Boolean(cached) && !force && isFresh(cached, now);
      states.push({
        year,
        cached,
        fresh,
        status: fresh ? 'fresh' : cached ? 'stale' : 'missing',
        data: cached,
      });
    }

    const needsFetch = states.some((state) => !state.fresh);
    if (!needsFetch) return mergeStates(states, { incomplete: false, stale: false });

    const refresh = async () => {
      const refreshed = await Promise.all(
        states.map((state) => (
          state.fresh
            ? Promise.resolve({ ...state, stale: false })
            : fetchAndStore(state, { year: state.year, now, storage, fetchImpl: request })
        )),
      );
      return mergeStates(refreshed);
    };

    const allCached = states.every((state) => Boolean(state.cached));
    if (!force && allCached) {
      const pending = refresh()
        .then((result) => {
          if (typeof onUpdate === 'function') onUpdate(result);
          return result;
        })
        .catch(() => null);
      if (typeof onUpdate !== 'function') void pending;
      return mergeStates(states, {
        incomplete: false,
        stale: true,
        revalidating: true,
      });
    }

    return await refresh();
  } catch {
    // Last-resort safety: keep whatever the cache offered and say it is
    // incomplete when nothing usable exists.
    const fallbackStates = [];
    for (const year of uniqueYears) {
      const cached = await readCache(storage, year);
      fallbackStates.push({
        year,
        cached,
        fresh: false,
        status: cached ? 'stale' : 'missing',
        data: cached,
      });
    }
    return mergeStates(fallbackStates);
  }
}
