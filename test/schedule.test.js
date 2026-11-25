import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PEAK_WINDOWS_UTC,
  beijingDateKey,
  formatCountdown,
  formatLocalDuration,
  formatLocalTime,
  formatLocalWeekday,
  isPeakAt,
  localDay,
  localDays,
  nextTransition,
  parseCalendar,
  parseChineseDays,
} from '../src/schedule.js';

const HOUR = 60 * 60 * 1000;
const utc = (value) => Date.parse(value);
const readFixture = (name) => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
);

const holidayCn2027 = parseCalendar(readFixture('holiday-cn-2027.json'));
const chineseDays2027 = parseChineseDays(readFixture('chinese-days-2027.json'), 2027);
const EMPTY = new Set();

test('peak windows are the documented UTC boundaries', () => {
  assert.deepEqual(PEAK_WINDOWS_UTC, [[1, 4], [6, 10]]);
});

test('peak windows are end-exclusive on a weekday', () => {
  assert.equal(isPeakAt(utc('2026-11-25T02:00:00Z'), EMPTY), true);
  assert.equal(isPeakAt(utc('2026-11-25T04:00:00Z'), EMPTY), false);
  assert.equal(isPeakAt(utc('2026-11-25T06:00:00Z'), EMPTY), true);
  assert.equal(isPeakAt(utc('2026-11-25T10:00:00Z'), EMPTY), false);
  assert.equal(isPeakAt(utc('2026-11-25T05:59:59.999Z'), EMPTY), false);
});

test('weekends are off-peak', () => {
  assert.equal(isPeakAt(utc('2026-11-28T02:00:00Z'), EMPTY), false);
  assert.equal(beijingDateKey(utc('2026-11-28T02:00:00Z')), '2026-11-28');
});

test('a Chinese holiday is off-peak even on a Monday', () => {
  assert.equal(isPeakAt(utc('2027-04-05T02:00:00Z'), holidayCn2027.offDays), false);
  assert.equal(isPeakAt(utc('2027-04-05T02:00:00Z'), EMPTY), true);
});

test('next transition from inside the morning peak is its end', () => {
  assert.equal(
    nextTransition(utc('2026-11-25T03:00:00Z'), EMPTY),
    utc('2026-11-25T04:00:00Z'),
  );
});

test('next transition from Friday morning is Monday 01:00 UTC', () => {
  assert.equal(
    nextTransition(utc('2026-11-27T10:00:00Z'), EMPTY),
    utc('2026-11-30T01:00:00Z'),
  );
});

test('next transition after the 2027 Spring Festival break is Feb 15 01:00 UTC', () => {
  // Official 2027 schedule: Spring Festival off days run Feb 5 through Feb 13,
  // Feb 14 is a working Sunday (still off-peak as a weekend), so the first
  // peak after the break is Monday Feb 15 at 01:00 UTC.
  assert.equal(
    nextTransition(utc('2027-02-05T02:00:00Z'), holidayCn2027.offDays),
    utc('2027-02-15T01:00:00Z'),
  );
});

test('Toronto local day clips both UTC peak windows correctly', () => {
  assert.equal(new Date(utc('2026-11-25T16:00:00Z')).getTimezoneOffset(), 300);
  const day = localDay(utc('2026-11-25T16:00:00Z'), EMPTY);
  assert.equal(day.dateKey, '2026-11-25');
  assert.deepEqual(day.intervals, [
    { start: utc('2026-11-25T06:00:00Z'), end: utc('2026-11-25T10:00:00Z') },
    { start: utc('2026-11-26T01:00:00Z'), end: utc('2026-11-26T04:00:00Z') },
  ]);
  assert.deepEqual(day.intervals.map(formatLocalDuration), ['01:00–05:00', '20:00–23:00']);
});

test('a half-hour time zone keeps both intervals', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata';
  try {
    const day = localDay(utc('2026-11-25T12:00:00Z'), EMPTY);
    assert.equal(day.dateKey, '2026-11-25');
    assert.deepEqual(day.intervals.map(formatLocalDuration), ['06:30–09:30', '11:30–15:30']);
    assert.deepEqual(day.intervals, [
      { start: utc('2026-11-25T01:00:00Z'), end: utc('2026-11-25T04:00:00Z') },
      { start: utc('2026-11-25T06:00:00Z'), end: utc('2026-11-25T10:00:00Z') },
    ]);
  } finally {
    process.env.TZ = previous;
  }
});

test('localDays returns seven consecutive local days', () => {
  const days = localDays(utc('2026-11-25T16:00:00Z'), EMPTY, 7);
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((day) => day.dateKey), [
    '2026-11-25',
    '2026-11-26',
    '2026-11-27',
    '2026-11-28',
    '2026-11-29',
    '2026-11-30',
    '2026-12-01',
  ]);
  assert.deepEqual(days[3].intervals, []);
  assert.deepEqual(days[6].intervals.map(formatLocalDuration), ['01:00–05:00', '20:00–23:00']);
});

test('countdown formatting switches at 24 hours and clamps at zero', () => {
  assert.equal(formatCountdown(0), '00:00:00');
  assert.equal(formatCountdown(-5000), '00:00:00');
  assert.equal(formatCountdown(23 * HOUR + 59 * 60 * 1000 + 59 * 1000), '23:59:59');
  assert.equal(formatCountdown(24 * HOUR), '1d 00h 00m');
  assert.equal(formatCountdown(25 * HOUR + 61 * 1000), '1d 01h 01m');
  assert.equal(formatCountdown(10 * 24 * HOUR + 5 * HOUR + 30 * 60 * 1000), '10d 05h 30m');
});

test('local time helpers use a 24-hour cycle and two-digit day numbers', () => {
  const timestamp = utc('2026-11-25T16:00:00Z');
  assert.equal(formatLocalTime(timestamp, 'en-GB'), '11:00');
  assert.equal(formatLocalWeekday(timestamp, 'en-GB'), 'Wed 25');
  assert.equal(formatLocalWeekday(utc('2026-12-01T16:00:00Z'), 'en-GB'), 'Tue 01');
});

test('parseCalendar keeps only official off days and the paper link', () => {
  const parsed = parseCalendar({
    year: 2027,
    papers: ['https://www.gov.cn/example'],
    days: [
      { name: 'A', date: '2027-02-05', isOffDay: true },
      { name: 'B', date: '2027-02-14', isOffDay: false },
    ],
  });
  assert.deepEqual([...parsed.offDays], ['2027-02-05']);
  assert.deepEqual(parsed.papers, ['https://www.gov.cn/example']);
  assert.equal(parsed.year, 2027);
});

test('parseCalendar rejects a wrong year and invalid day entries', () => {
  assert.throws(() => parseCalendar({ year: '2027', days: [] }), TypeError);
  assert.throws(() => parseCalendar({ year: 2027 }), TypeError);
  assert.throws(
    () => parseCalendar({ year: 2027, days: [{ date: '2027-13-01', isOffDay: true }] }),
    TypeError,
  );
  assert.throws(
    () => parseCalendar({ year: 2027, days: [{ date: '2027-02-05', isOffDay: 'yes' }] }),
    TypeError,
  );
});

test('chinese-days fixture normalizes to the same 2027 off-day set', () => {
  assert.equal(chineseDays2027.year, 2027);
  assert.deepEqual(
    [...chineseDays2027.offDays].sort(),
    [...holidayCn2027.offDays].sort(),
  );
  assert.deepEqual(chineseDays2027.papers, ['https://github.com/vsme/chinese-days']);
});

test('chinese-days fixture keeps Spring Festival Feb 5-13 off-peak', () => {
  for (let day = 5; day <= 13; day += 1) {
    const key = `2027-02-${String(day).padStart(2, '0')}`;
    assert.ok(chineseDays2027.offDays.has(key), `${key} is missing`);
    assert.equal(isPeakAt(utc(`${key}T02:00:00Z`), chineseDays2027.offDays), false, key);
  }
  // Feb 14 is a working Sunday; weekends are off-peak anyway.
  assert.equal(isPeakAt(utc('2027-02-14T02:00:00Z'), chineseDays2027.offDays), false);
  assert.equal(isPeakAt(utc('2027-02-15T01:00:00Z'), chineseDays2027.offDays), true);
});

test('parseChineseDays rejects an empty or malformed payload', () => {
  assert.throws(() => parseChineseDays({ holidays: {} }, 2027), TypeError);
  assert.throws(
    () => parseChineseDays({ holidays: { '2027-02-30': 'Spring Festival' } }, 2027),
    TypeError,
  );
  assert.throws(
    () => parseChineseDays({ holidays: { '2026-02-05': 'Spring Festival' } }, 2027),
    TypeError,
  );
  assert.throws(() => parseChineseDays({}, 2027), TypeError);
});
