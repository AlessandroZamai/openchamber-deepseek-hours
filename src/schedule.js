// Pure scheduling and pricing logic for DeepSeek API peak / off-peak hours.
// No imports: everything here is deterministic and testable in isolation.

export const PEAK_WINDOWS_UTC = [[1, 4], [6, 10]];

const HOUR_MS = 60 * 60 * 1000;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const BEIJING_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const EMPTY_OFF_DAYS = new Set();

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isValidDateKey(key) {
  if (typeof key !== 'string' || !DATE_KEY_RE.test(key)) return false;
  const [, year, month, day] = key.match(DATE_KEY_RE);
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

/** Beijing calendar date (`YYYY-MM-DD`) containing the instant. */
export function beijingDateKey(ms) {
  const parts = BEIJING_DATE.formatToParts(new Date(ms));
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/**
 * Parse one holiday-cn calendar document.
 * Throws on anything that does not look like the documented shape.
 */
export function parseCalendar(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new TypeError('Calendar must be an object');
  }
  if (!Number.isInteger(json.year) || json.year < 1970 || json.year > 9999) {
    throw new TypeError('Calendar year must be an integer');
  }
  if (!Array.isArray(json.days)) {
    throw new TypeError('Calendar days must be an array');
  }
  const offDays = new Set();
  for (const entry of json.days) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Calendar day entry must be an object');
    }
    if (!isValidDateKey(entry.date)) {
      throw new TypeError(`Invalid calendar date: ${String(entry.date)}`);
    }
    if (typeof entry.isOffDay !== 'boolean') {
      throw new TypeError(`Calendar day ${entry.date} needs a boolean isOffDay`);
    }
    if (entry.isOffDay) offDays.add(entry.date);
  }
  const papers = Array.isArray(json.papers)
    ? json.papers.filter((paper) => typeof paper === 'string' && paper.length > 0)
    : [];
  return { year: json.year, offDays, papers };
}

/** Source link used when the chinese-days dataset supplies a year. */
export const CHINESE_DAYS_SOURCE = 'https://github.com/vsme/chinese-days';

/**
 * Normalize the chinese-days year document. It has no `year` field and a
 * completely different shape: `holidays` maps every off day to a name.
 * `workdays` is ignored because weekends are already off-peak.
 */
export function parseChineseDays(json, year = null) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new TypeError('chinese-days calendar must be an object');
  }
  if (year !== null && (!Number.isInteger(year) || year < 1970 || year > 9999)) {
    throw new TypeError('chinese-days year must be an integer');
  }
  const holidays = json.holidays;
  if (!holidays || typeof holidays !== 'object' || Array.isArray(holidays)) {
    throw new TypeError('chinese-days calendar needs a holidays object');
  }
  const keys = Object.keys(holidays);
  if (keys.length === 0) {
    throw new TypeError('chinese-days calendar has no holidays');
  }
  const offDays = new Set();
  let detectedYear = null;
  for (const key of keys) {
    if (!isValidDateKey(key)) {
      throw new TypeError(`Invalid chinese-days date: ${key}`);
    }
    const keyYear = Number(key.slice(0, 4));
    if (year !== null && keyYear !== year) {
      throw new TypeError(`chinese-days date ${key} is outside ${year}`);
    }
    if (detectedYear === null) detectedYear = keyYear;
    else if (detectedYear !== keyYear) {
      throw new TypeError('chinese-days calendar mixes years');
    }
    offDays.add(key);
  }
  return {
    year: year ?? detectedYear,
    offDays,
    papers: [CHINESE_DAYS_SOURCE],
  };
}

/**
 * Peak evaluation order: Beijing holiday, then UTC weekend, then UTC window.
 * Windows are end-exclusive.
 */
export function isPeakAt(ms, offDays = EMPTY_OFF_DAYS) {
  const off = offDays ?? EMPTY_OFF_DAYS;
  if (off.has(beijingDateKey(ms))) return false;

  const date = new Date(ms);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;

  const hour = date.getUTCHours();
  for (const [start, end] of PEAK_WINDOWS_UTC) {
    if (hour >= start && hour < end) return true;
  }
  return false;
}

/**
 * First instant strictly after `ms` where peak state changes.
 * Peak state only changes on UTC hour boundaries, so an hourly scan is exact.
 * The scan covers 60 days, well beyond the longest Chinese holiday break.
 */
export function nextTransition(ms, offDays = EMPTY_OFF_DAYS) {
  const current = isPeakAt(ms, offDays);
  let cursor = Math.floor(ms / HOUR_MS) * HOUR_MS + HOUR_MS;
  for (let i = 0; i < 24 * 60; i += 1) {
    if (isPeakAt(cursor, offDays) !== current) return cursor;
    cursor += HOUR_MS;
  }
  return cursor;
}

function localDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Local calendar day containing `ms`, with peak intervals clipped to it.
 * Boundaries are walked on UTC hour boundaries, never fixed steps, so
 * half-hour time zones do not lose or shift an interval.
 */
export function localDay(ms, offDays = EMPTY_OFF_DAYS) {
  const date = new Date(ms);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();

  const intervals = [];
  let current = isPeakAt(start, offDays);
  let intervalStart = current ? start : null;
  let boundary = Math.ceil(start / HOUR_MS) * HOUR_MS;
  if (boundary <= start) boundary += HOUR_MS;

  while (boundary < end) {
    const state = isPeakAt(boundary, offDays);
    if (state !== current) {
      if (current) intervals.push({ start: intervalStart, end: boundary });
      else intervalStart = boundary;
      current = state;
    }
    boundary += HOUR_MS;
  }
  if (current) intervals.push({ start: intervalStart, end });

  return { dateKey: localDateKey(date), start, end, intervals };
}

/** The local day containing `ms` plus the following `count - 1` local days. */
export function localDays(ms, offDays = EMPTY_OFF_DAYS, count = 7) {
  const base = new Date(ms);
  const days = [];
  for (let i = 0; i < count; i += 1) {
    // Noon sidesteps time zones whose DST transition lands on midnight.
    const noon = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + i,
      12,
      0,
      0,
      0,
    ).getTime();
    days.push(localDay(noon, offDays));
  }
  return days;
}

/** `HH:MM:SS` under 24h, `Nd HHh MMm` at or above, clamped at zero. */
export function formatCountdown(ms) {
  const safe = Number.isFinite(ms) ? ms : 0;
  const totalSeconds = Math.max(0, Math.floor(safe / 1000));
  if (totalSeconds >= 86400) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${days}d ${pad2(hours)}h ${pad2(minutes)}m`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** `HH:MM` in local time, 24-hour cycle. */
export function formatLocalTime(ms, locale = 'en') {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat(locale || 'en', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  return formatter.format(new Date(ms));
}

/** Short weekday plus two-digit day number, for example `Tue 01`. */
export function formatLocalWeekday(ms, locale = 'en') {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat(locale || 'en', {
      weekday: 'short',
      day: '2-digit',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en', { weekday: 'short', day: '2-digit' });
  }
  const parts = formatter.formatToParts(new Date(ms));
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  return `${weekday} ${day}`.trim();
}

/** `20:00–23:00` in local time. */
export function formatLocalDuration(interval) {
  const start = new Date(interval.start);
  const end = new Date(interval.end);
  return `${pad2(start.getHours())}:${pad2(start.getMinutes())}–${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
}

// USD per 1M tokens. Off-peak is exactly half of peak.
export const PRICES = {
  'deepseek-flash': {
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    off: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
    off: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
  },
};

export const PRICES_VERIFIED = '2026-11-24';
