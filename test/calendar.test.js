import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CACHE_TTL_MS,
  calendarCacheKey,
  loadCalendar,
} from '../src/calendar.js';
import { isPeakAt } from '../src/schedule.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-24T12:00:00Z');

const chineseDays2027 = JSON.parse(
  readFileSync(new URL('./fixtures/chinese-days-2027.json', import.meta.url), 'utf8'),
);

const holidayCn2026 = {
  year: 2026,
  papers: ['https://www.gov.cn/zhengce/2026-example.htm'],
  days: [
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '元旦', date: '2026-01-02', isOffDay: true },
    { name: '元旦', date: '2026-01-04', isOffDay: false },
  ],
};

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async keys() {
      return [...values.keys()].sort();
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    async json() {
      throw new Error('no body');
    },
  };
}

function offline() {
  throw new Error('network down');
}

function oldCache(overrides = {}) {
  return {
    v: 1,
    year: 2026,
    offDays: ['2026-01-01'],
    papers: ['https://www.gov.cn/cached'],
    fetchedAt: NOW - 2 * CACHE_TTL_MS,
    source: 'https://cached.example/2026.json',
    dataset: 'holiday-cn',
    ...overrides,
  };
}

test('primary holiday-cn failure falls back to jsDelivr', async () => {
  const storage = memoryStorage();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://raw.githubusercontent.com/')) throw new Error('down');
    if (url.startsWith('https://cdn.jsdelivr.net/')) return jsonResponse(holidayCn2026);
    return notFoundResponse();
  };

  const result = await loadCalendar({ years: [2026], storage, fetchImpl, now: NOW });
  assert.equal(result.incomplete, false);
  assert.equal(result.stale, false);
  assert.equal(result.entries[0].dataset, 'holiday-cn');
  assert.match(result.entries[0].source, /cdn\.jsdelivr\.net/);
  assert.ok(result.offDays.has('2026-01-01'));
  assert.equal(result.papers[0], holidayCn2026.papers[0]);

  const cached = await storage.get(calendarCacheKey(2026));
  assert.equal(cached.dataset, 'holiday-cn');
  assert.equal(cached.year, 2026);
  assert.equal(calls.length, 2);
});

test('both holiday-cn sources failing falls back to chinese-days on unpkg', async () => {
  const storage = memoryStorage();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://raw.githubusercontent.com/')) throw new Error('down');
    if (url.startsWith('https://cdn.jsdelivr.net/')) throw new Error('down');
    if (url.startsWith('https://unpkg.com/chinese-days@2/')) return jsonResponse(chineseDays2027);
    return notFoundResponse();
  };

  const result = await loadCalendar({ years: [2027], storage, fetchImpl, now: NOW });
  assert.equal(result.incomplete, false);
  assert.equal(result.stale, false);
  assert.equal(result.entries[0].dataset, 'chinese-days');
  assert.match(result.entries[0].source, /unpkg\.com/);
  assert.equal(result.papers[0], 'https://github.com/vsme/chinese-days');

  for (let day = 5; day <= 13; day += 1) {
    const key = `2027-02-${String(day).padStart(2, '0')}`;
    assert.ok(result.offDays.has(key), `${key} is missing`);
    assert.equal(isPeakAt(Date.parse(`${key}T02:00:00Z`), result.offDays), false, key);
  }
  assert.equal(isPeakAt(Date.parse('2027-02-15T01:00:00Z'), result.offDays), true);

  const cached = await storage.get(calendarCacheKey(2027));
  assert.equal(cached.dataset, 'chinese-days');
  assert.deepEqual(cached.papers, ['https://github.com/vsme/chinese-days']);
  assert.equal(calls.length, 3);
});

test('an invalid chinese-days payload is rejected, not accepted', async () => {
  const storage = memoryStorage();
  const fetchImpl = async (url) => {
    if (url.startsWith('https://unpkg.com/')) {
      return jsonResponse({ holidays: { 'not-a-date': 'broken' } });
    }
    throw new Error('holiday-cn down');
  };

  const result = await loadCalendar({ years: [2027], storage, fetchImpl, now: NOW });
  assert.equal(result.incomplete, true);
  assert.equal(result.stale, false);
  assert.equal(result.offDays.size, 0);
  assert.equal(result.entries[0].status, 'missing');
  assert.equal(result.entries[0].dataset, null);
  assert.equal(await storage.get(calendarCacheKey(2027)), undefined);
});

test('an expired cache renders immediately and refreshes in the background', async () => {
  const storage = memoryStorage({ [calendarCacheKey(2026)]: oldCache() });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    await gate;
    return jsonResponse(holidayCn2026);
  };
  let updated = null;

  const immediate = await loadCalendar({
    years: [2026],
    storage,
    fetchImpl,
    now: NOW,
    onUpdate: (result) => {
      updated = result;
    },
  });

  assert.equal(immediate.stale, true);
  assert.equal(immediate.revalidating, true);
  assert.equal(immediate.incomplete, false);
  assert.ok(immediate.offDays.has('2026-01-01'));
  assert.equal(fetchCount, 1, 'the background refresh starts without blocking');

  release();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(updated, 'onUpdate receives the refreshed calendar');
  assert.equal(updated.stale, false);
  assert.equal(updated.entries[0].status, 'fetched');
  assert.ok(updated.offDays.has('2026-01-02'));

  const cached = await storage.get(calendarCacheKey(2026));
  assert.equal(cached.dataset, 'holiday-cn');
  assert.equal(cached.fetchedAt, NOW);
});

test('a forced refresh that fails keeps a stale cached calendar', async () => {
  const storage = memoryStorage({ [calendarCacheKey(2026)]: oldCache() });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('offline');
  };

  const result = await loadCalendar({
    years: [2026],
    storage,
    fetchImpl,
    now: NOW,
    force: true,
  });

  assert.equal(result.incomplete, false);
  assert.equal(result.stale, true);
  assert.equal(result.entries[0].status, 'stale');
  assert.ok(result.offDays.has('2026-01-01'));
  assert.equal(calls, 3, 'all three sources are attempted');
});

test('three 404s mark the year not published and cache it for six hours', async () => {
  const storage = memoryStorage();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return notFoundResponse();
  };

  const result = await loadCalendar({ years: [2026], storage, fetchImpl, now: NOW });
  assert.equal(result.incomplete, false);
  assert.equal(result.stale, false);
  assert.equal(result.entries[0].notPublished, true);
  assert.equal(result.entries[0].status, 'notPublished');
  assert.equal(calls, 3);

  const cached = await storage.get(calendarCacheKey(2026));
  assert.equal(cached.notPublished, true);

  let laterCalls = 0;
  const later = await loadCalendar({
    years: [2026],
    storage,
    fetchImpl: async () => {
      laterCalls += 1;
      throw new Error('should not fetch');
    },
    now: NOW + 5 * HOUR,
  });
  assert.equal(later.entries[0].notPublished, true);
  assert.equal(laterCalls, 0, 'a six-hour notPublished cache is fresh');
});

test('no cache and no source means incomplete, not a silent Mon-Fri calendar', async () => {
  const storage = memoryStorage();
  const result = await loadCalendar({
    years: [2026],
    storage,
    fetchImpl: offline,
    now: NOW,
  });

  assert.equal(result.incomplete, true);
  assert.equal(result.stale, false);
  assert.equal(result.offDays.size, 0);
  assert.equal(result.papers.length, 0);
  assert.equal(result.fetchedAt, null);
  assert.equal(result.entries[0].status, 'missing');
  assert.equal(await storage.get(calendarCacheKey(2026)), undefined);
});
