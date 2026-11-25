import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import {
  PRICES,
  PRICES_VERIFIED,
  beijingDateKey,
  formatCountdown,
  formatLocalDuration,
  formatLocalTime,
  formatLocalWeekday,
  isPeakAt,
  localDay,
  localDays,
  nextTransition,
} from './schedule.js';
import { loadCalendar } from './calendar.js';

const host = connectHost();
const root = document.querySelector('#root');

let context = null;
let view = null;
let started = false;
let calendar = emptyCalendar();
let calendarLoaded = false;
let calendarBusy = false;
let calendarStamp = 0;
let loadedYear = null;
let statusHeight = 0;
let refreshTimer = null;

const REFRESH_OK_MS = 6 * 60 * 60 * 1000;
const REFRESH_RETRY_MS = 60 * 1000;

function emptyCalendar() {
  return {
    offDays: new Set(),
    papers: [],
    entries: [],
    incomplete: false,
    stale: false,
    fetchedAt: null,
  };
}

function beijingYear(ms) {
  return Number(beijingDateKey(ms).slice(0, 4));
}

function calendarEntry(result, year) {
  if (!result || !Array.isArray(result.entries)) return null;
  return result.entries.find((entry) => entry.year === year) ?? null;
}

function currentYearUsable(result, now) {
  const entry = calendarEntry(result, beijingYear(now));
  return Boolean(entry) && entry.status !== 'missing' && entry.notPublished !== true;
}

function dateKeyToMs(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day).getTime();
}

function formatCalendarDate(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(ms));
}

function formatPrice(value) {
  return value >= 0.1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nowMarkerLeft(now, day) {
  const percentage = ((now - day.start) / (day.end - day.start)) * 100;
  return `clamp(1px, ${clamp(percentage, 0, 100)}%, calc(100% - 2px))`;
}

function daylineText(day, now) {
  const holiday = calendar.offDays.has(beijingDateKey(now));
  if (day.intervals.length === 0) {
    return holiday ? 'Holiday · off-peak all day' : 'Today · off-peak all day';
  }
  return `Today · ${day.intervals.map(formatLocalDuration).join(' · ')}`;
}

function ribbonTitle(day) {
  if (day.intervals.length === 0) return 'Off-peak all day.';
  return `Peak today: ${day.intervals.map(formatLocalDuration).join(', ')} local. Off-peak otherwise.`;
}

function relativeDay(now, transition) {
  const today = localDay(now, calendar.offDays);
  const target = localDay(transition, calendar.offDays);
  if (target.dateKey === today.dateKey) return 'today';
  const tomorrow = localDay(today.end + 1000, calendar.offDays);
  if (target.dateKey === tomorrow.dateKey) return 'tomorrow';
  return `on ${formatLocalWeekday(transition, context?.locale ?? 'en')}`;
}

async function loadCalendarData(force) {
  if (calendarBusy) return;
  calendarBusy = true;
  view?.setBusy(true);

  const now = Date.now();
  const year = beijingYear(now);
  try {
    const result = await loadCalendar({
      years: [year, year + 1],
      storage: host.storage,
      fetchImpl: (url, init) => fetch(url, init),
      now,
      force,
      onUpdate: (next) => {
        calendar = next;
        calendarLoaded = true;
        loadedYear = year;
        calendarStamp += 1;
        view?.update(true);
        scheduleRefresh();
      },
    });
    calendar = result;
    calendarLoaded = true;
    loadedYear = year;
    calendarStamp += 1;

    if (force) {
      const ok = currentYearUsable(result, now);
      void host.toast({
        kind: ok ? 'success' : 'error',
        message: ok ? 'Holiday calendar refreshed' : 'Holiday calendar refresh failed',
      });
    }
  } catch {
    calendarLoaded = true;
    if (force) {
      void host.toast({ kind: 'error', message: 'Holiday calendar refresh failed' });
    }
  } finally {
    calendarBusy = false;
    view?.setBusy(false);
    view?.update(true);
    scheduleRefresh();
  }
}

function scheduleRefresh(now = Date.now()) {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  const delay = currentYearUsable(calendar, now) ? REFRESH_OK_MS : REFRESH_RETRY_MS;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void loadCalendarData(false);
  }, delay);
}

function tick() {
  if (!view) return;
  const year = beijingYear(Date.now());
  if (loadedYear !== null && year !== loadedYear) {
    void loadCalendarData(false);
  }
  view.update(false);
}

function scheduleStatusHeight(el) {
  requestAnimationFrame(() => {
    if (view?.kind !== 'status') return;
    const height = clamp(Math.ceil(el.getBoundingClientRect().height), 24, 480);
    if (height !== statusHeight) {
      statusHeight = height;
      void host.setHeight(height).catch(() => {});
    }
  });
}

function buildRibbon(container, day) {
  container.replaceChildren();
  const span = day.end - day.start;
  for (const interval of day.intervals) {
    const block = document.createElement('span');
    block.className = 'dh-ribbon-block';
    block.style.left = `${((interval.start - day.start) / span) * 100}%`;
    block.style.width = `${((interval.end - interval.start) / span) * 100}%`;
    container.append(block);
  }
}

function mountStatus() {
  const el = document.createElement('div');
  el.className = 'dh dh-status';
  el.innerHTML = `
    <div class="dh-status-top">
      <span class="dh-state" role="status" aria-live="polite"><span class="dh-dot" aria-hidden="true"></span><span class="dh-state-text"></span></span>
      <span class="dh-mult"></span>
    </div>
    <div class="dh-status-next">
      <span class="dh-next-label"></span>
      <span class="dh-countdown"></span>
    </div>
    <div class="dh-ribbon" role="img">
      <div class="dh-ribbon-track">
        <div class="dh-ribbon-peaks"></div>
        <div class="dh-ribbon-now"></div>
      </div>
    </div>
    <div class="dh-dayline">
      <span class="dh-dayline-text"></span>
      <span class="dh-warn" hidden title="Holiday calendar unavailable — showing Mon–Fri peak hours only" aria-label="Holiday calendar unavailable — showing Mon–Fri peak hours only">!</span>
    </div>`;
  root.append(el);

  const refs = {
    state: el.querySelector('.dh-state'),
    stateText: el.querySelector('.dh-state-text'),
    mult: el.querySelector('.dh-mult'),
    nextLabel: el.querySelector('.dh-next-label'),
    countdown: el.querySelector('.dh-countdown'),
    ribbon: el.querySelector('.dh-ribbon'),
    peaks: el.querySelector('.dh-ribbon-peaks'),
    now: el.querySelector('.dh-ribbon-now'),
    dayline: el.querySelector('.dh-dayline-text'),
    warn: el.querySelector('.dh-warn'),
  };

  let lastStructural = '';

  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => scheduleStatusHeight(el))
    : null;
  observer?.observe(el);
  window.addEventListener('resize', () => scheduleStatusHeight(el));

  return {
    kind: 'status',
    setBusy() {},
    update() {
      const now = Date.now();
      const peak = isPeakAt(now, calendar.offDays);
      const transition = nextTransition(now, calendar.offDays);
      const day = localDay(now, calendar.offDays);
      const structural = `${day.dateKey}|${calendarStamp}`;

      refs.state.classList.toggle('is-peak', peak);
      refs.state.classList.toggle('is-off', !peak);
      const stateLabel = peak ? 'Peak' : 'Off-peak';
      if (refs.stateText.textContent !== stateLabel) {
        refs.stateText.textContent = stateLabel;
      }
      refs.mult.textContent = peak ? '2× rate' : '50% off';
      refs.nextLabel.textContent = peak ? 'Off-peak in' : 'Peak in';
      refs.countdown.textContent = formatCountdown(transition - now);

      const title = ribbonTitle(day);
      refs.ribbon.title = title;
      refs.ribbon.setAttribute('aria-label', title);

      if (structural !== lastStructural) {
        lastStructural = structural;
        buildRibbon(refs.peaks, day);
      }

      refs.now.style.left = nowMarkerLeft(now, day);
      refs.dayline.textContent = daylineText(day, now);
      refs.warn.hidden = !(calendarLoaded && !currentYearUsable(calendar, now));

      scheduleStatusHeight(el);
    },
  };
}

function buildPriceTable() {
  const table = document.createElement('table');
  table.className = 'dh-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const [label, className] of [
    ['Prices per 1M tokens', ''],
    ['Peak', 'dh-price-peak'],
    ['Off', 'dh-price-off'],
  ]) {
    const th = document.createElement('th');
    th.textContent = label;
    if (className) th.className = className;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  const items = [
    ['Cache miss input', 'cacheMiss'],
    ['Cache hit input', 'cacheHit'],
    ['Output', 'output'],
  ];
  for (const [model, prices] of Object.entries(PRICES)) {
    const modelRow = document.createElement('tr');
    modelRow.className = 'dh-model-row';
    const modelCell = document.createElement('th');
    modelCell.colSpan = 3;
    modelCell.textContent = model;
    modelRow.append(modelCell);
    tbody.append(modelRow);

    for (const [label, key] of items) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = label;
      const peak = document.createElement('td');
      peak.className = 'dh-price-peak';
      peak.textContent = formatPrice(prices.peak[key]);
      const off = document.createElement('td');
      off.className = 'dh-price-off';
      off.textContent = formatPrice(prices.off[key]);
      row.append(name, peak, off);
      tbody.append(row);
    }
  }
  table.append(tbody);
  return table;
}

function buildPriceCards() {
  const cards = document.createElement('div');
  cards.className = 'dh-cards';
  const items = [
    ['Cache miss input', 'cacheMiss'],
    ['Cache hit input', 'cacheHit'],
    ['Output', 'output'],
  ];

  for (const [tone, label] of [['peak', 'Peak'], ['off', 'Off']]) {
    const card = document.createElement('div');
    card.className = `dh-price-card dh-price-card-${tone}`;
    const head = document.createElement('div');
    head.className = 'dh-price-card-head';
    head.textContent = label;
    card.append(head);

    for (const [model, prices] of Object.entries(PRICES)) {
      const modelName = document.createElement('div');
      modelName.className = 'dh-card-model';
      modelName.textContent = model;
      card.append(modelName);
      for (const [itemLabel, key] of items) {
        const row = document.createElement('div');
        row.className = 'dh-card-row';
        const name = document.createElement('span');
        name.textContent = itemLabel;
        const value = document.createElement('span');
        value.className = 'dh-card-value';
        value.textContent = formatPrice(prices[tone][key]);
        row.append(name, value);
        card.append(row);
      }
    }
    cards.append(card);
  }
  return cards;
}

function mountFull() {
  const el = document.createElement('div');
  el.className = 'dh dh-panel';
  el.innerHTML = `
    <header class="dh-header">
      <div class="dh-header-top">
        <span class="dh-pill"><span class="dh-dot" aria-hidden="true"></span><span class="dh-pill-text"></span></span>
        <span class="dh-mult"></span>
      </div>
      <div class="dh-next-label"></div>
      <div class="dh-countdown"></div>
      <div class="dh-transition"></div>
    </header>
    <section class="dh-section">
      <div class="dh-section-head"><span>24 hours</span><span class="dh-timeline-date"></span></div>
      <div class="dh-timeline" role="img">
        <div class="dh-timeline-track">
          <div class="dh-timeline-peaks"></div>
          <div class="dh-timeline-now"></div>
        </div>
        <div class="dh-ticks" aria-hidden="true"></div>
      </div>
    </section>
    <section class="dh-section">
      <div class="dh-section-head"><span>Next 7 days</span></div>
      <div class="dh-days"></div>
    </section>
    <section class="dh-section dh-prices">
      <div class="dh-price-table-wrap"></div>
      <div class="dh-cards-wrap"></div>
      <div class="dh-price-note"></div>
    </section>
    <footer class="dh-footer">
      <div class="dh-source-line"></div>
      <button type="button" class="dh-refresh" data-action="refresh">Refresh</button>
    </footer>
    <div class="dh-notes"></div>`;
  root.append(el);

  const refs = {
    pill: el.querySelector('.dh-pill'),
    pillText: el.querySelector('.dh-pill-text'),
    mult: el.querySelector('.dh-mult'),
    nextLabel: el.querySelector('.dh-next-label'),
    countdown: el.querySelector('.dh-countdown'),
    transition: el.querySelector('.dh-transition'),
    timeline: el.querySelector('.dh-timeline'),
    timelineDate: el.querySelector('.dh-timeline-date'),
    peaks: el.querySelector('.dh-timeline-peaks'),
    now: el.querySelector('.dh-timeline-now'),
    ticks: el.querySelector('.dh-ticks'),
    days: el.querySelector('.dh-days'),
    sourceLine: el.querySelector('.dh-source-line'),
    refresh: el.querySelector('.dh-refresh'),
    notes: el.querySelector('.dh-notes'),
    priceNote: el.querySelector('.dh-price-note'),
    tableWrap: el.querySelector('.dh-price-table-wrap'),
    cardsWrap: el.querySelector('.dh-cards-wrap'),
  };

  refs.tableWrap.append(buildPriceTable());
  refs.cardsWrap.append(buildPriceCards());

  const priceNote = document.createTextNode(`Prices verified ${formatCalendarDate(dateKeyToMs(PRICES_VERIFIED))} · `);
  const pricingLink = document.createElement('button');
  pricingLink.type = 'button';
  pricingLink.className = 'dh-link';
  pricingLink.dataset.action = 'pricing';
  pricingLink.textContent = 'DeepSeek pricing ↗';
  refs.priceNote.append(priceNote, pricingLink);

  el.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'pricing') {
      void host.openUrl('https://api-docs.deepseek.com/quick_start/pricing/');
    } else if (action === 'refresh') {
      void loadCalendarData(true);
    } else if (action === 'source') {
      const url = target.dataset.url;
      if (url) void host.openUrl(url);
    }
  });

  let lastDayKey = '';
  let lastStamp = -1;
  let lastLocale = '';

  const paintTimeline = (day) => {
    refs.peaks.replaceChildren();
    const span = day.end - day.start;
    for (const interval of day.intervals) {
      const block = document.createElement('span');
      block.className = 'dh-timeline-block';
      block.style.left = `${((interval.start - day.start) / span) * 100}%`;
      block.style.width = `${((interval.end - interval.start) / span) * 100}%`;
      block.title = `Peak ${formatLocalDuration(interval)} local`;
      refs.peaks.append(block);
    }

    refs.ticks.replaceChildren();
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const at = fraction === 1 ? day.end : day.start + span * fraction;
      const tick = document.createElement('span');
      tick.className = 'dh-tick';
      if (fraction === 0) tick.classList.add('is-first');
      if (fraction === 1) tick.classList.add('is-last');
      if (fraction === 0.25 || fraction === 0.75) tick.classList.add('dh-tick-6');
      tick.style.left = `${fraction * 100}%`;
      tick.textContent = fraction === 1
        ? '24'
        : String(new Date(at).getHours()).padStart(2, '0');
      refs.ticks.append(tick);
    }
    refs.timelineDate.textContent = formatLocalWeekday(day.start + (day.end - day.start) / 2, context?.locale ?? 'en');
  };

  const paintDays = (now) => {
    refs.days.replaceChildren();
    const days = localDays(now, calendar.offDays, 7);
    days.forEach((day, index) => {
      const row = document.createElement('div');
      row.className = 'dh-day-row';
      if (index === 0) {
        row.classList.add('is-today');
        row.setAttribute('aria-current', 'date');
      }
      if (day.intervals.length === 0) row.classList.add('is-off');

      const label = document.createElement('span');
      label.className = 'dh-day-label';
      label.textContent = formatLocalWeekday(day.start + (day.end - day.start) / 2, context?.locale ?? 'en');
      row.append(label);

      const windows = document.createElement('span');
      windows.className = 'dh-day-windows';
      if (day.intervals.length === 0) {
        const off = document.createElement('span');
        off.className = 'dh-off';
        const dot = document.createElement('span');
        dot.className = 'dh-dot dh-dot-off';
        dot.setAttribute('aria-hidden', 'true');
        off.append(dot, document.createTextNode('off-peak all day'));
        windows.append(off);
      } else {
        for (const interval of day.intervals) {
          const pill = document.createElement('span');
          pill.className = 'dh-window';
          pill.textContent = formatLocalDuration(interval);
          windows.append(pill);
        }
      }
      row.append(windows);
      refs.days.append(row);
    });
  };

  const paintSource = (now) => {
    refs.sourceLine.replaceChildren();
    const year = beijingYear(now);
    const entry = calendar.entries.find((item) => item.year === year);
    const dataset = entry?.dataset;
    const label = dataset === 'chinese-days'
      ? 'Calendar: chinese-days backup'
      : 'Calendar: official State Council schedule';
    refs.sourceLine.append(document.createTextNode(
      calendar.fetchedAt
        ? `${label} · fetched ${formatCalendarDate(calendar.fetchedAt)}`
        : label,
    ));

    const sourceUrl = calendar.papers[0] ?? entry?.papers?.[0] ?? null;
    if (sourceUrl) {
      refs.sourceLine.append(document.createTextNode(' · '));
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'dh-link';
      link.dataset.action = 'source';
      link.dataset.url = sourceUrl;
      link.textContent = 'source ↗';
      refs.sourceLine.append(link);
    }

    refs.notes.replaceChildren();
    if (calendarLoaded && !currentYearUsable(calendar, now)) {
      const note = document.createElement('div');
      note.className = 'dh-note is-warn';
      note.textContent = 'Holiday calendar unavailable — showing Mon–Fri peak hours only';
      refs.notes.append(note);
    } else if (calendar.stale) {
      const note = document.createElement('div');
      note.className = 'dh-note';
      note.textContent = 'Showing a cached calendar';
      refs.notes.append(note);
    }
    const nextEntry = calendar.entries.find((item) => item.year === year + 1);
    if (nextEntry?.notPublished) {
      const note = document.createElement('div');
      note.className = 'dh-note';
      note.textContent = `${year + 1} calendar not published yet`;
      refs.notes.append(note);
    } else if (nextEntry?.status === 'missing') {
      const note = document.createElement('div');
      note.className = 'dh-note';
      note.textContent = "Next year's calendar unavailable";
      refs.notes.append(note);
    }
  };

  return {
    kind: 'full',
    setBusy(busy) {
      refs.refresh.disabled = busy;
    },
    update() {
      const now = Date.now();
      const peak = isPeakAt(now, calendar.offDays);
      const transition = nextTransition(now, calendar.offDays);
      const day = localDay(now, calendar.offDays);

      refs.pill.classList.toggle('is-peak', peak);
      refs.pill.classList.toggle('is-off', !peak);
      refs.pillText.textContent = peak ? 'PEAK' : 'OFF-PEAK';
      refs.mult.textContent = peak ? '2× peak' : '50% of peak';
      refs.nextLabel.textContent = peak ? 'Off-peak prices start in' : 'Peak prices start in';
      refs.countdown.textContent = formatCountdown(transition - now);
      refs.transition.textContent = `at ${formatLocalTime(transition, context?.locale ?? 'en')} local · ${relativeDay(now, transition)}`;

      const locale = context?.locale ?? 'en';
      const structural = day.dateKey !== lastDayKey
        || calendarStamp !== lastStamp
        || locale !== lastLocale;
      if (structural) {
        lastDayKey = day.dateKey;
        lastStamp = calendarStamp;
        lastLocale = locale;
        paintTimeline(day);
        paintDays(now);
        paintSource(now);
      }

      refs.now.style.left = nowMarkerLeft(now, day);

      const labelTitle = ribbonTitle(day);
      refs.timeline.setAttribute(
        'aria-label',
        `${labelTitle} Now ${formatLocalTime(now, locale)}.`,
      );
    },
  };
}

host.onReady((next) => {
  applyHostReady(next, document.documentElement);
  if (next.surface === 'background') return;
  if (!['panel', 'dialog', 'page', 'status'].includes(next.surface)) return;
  context = next;

  const kind = next.surface === 'status' ? 'status' : 'full';
  if (!view || view.kind !== kind) {
    root.replaceChildren();
    view = kind === 'status' ? mountStatus() : mountFull();
  }
  view.update(true);

  if (!started) {
    started = true;
    window.setInterval(tick, 1000);
    void loadCalendarData(false);
  }
});
