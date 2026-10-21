// Admin → Analytics: which services get the most orders, by week, month or quarter. English only, like the other admin screens.
import { api } from '../api.js';
import { h, money } from '../ui.js';

const PERIODS = [['week', 'Weeks'], ['month', 'Months'], ['quarter', 'Quarters']];
const NOUN = { week: 'week', month: 'month', quarter: 'quarter' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "6 Oct" for a week starting 2026-10-06, "Oct 26" for a month, "Q4 26" for a quarter. */
function bucketLabel(period, start) {
  const [y, m, d] = start.split('-').map(Number);
  if (period === 'week') return `${d} ${MONTHS[m - 1]}`;
  if (period === 'month') return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
  return `Q${Math.floor((m - 1) / 3) + 1} ${String(y).slice(2)}`;
}
const pct = (x) => `${Math.round(x * 100)}%`;
const arrow = (c) => (c === null ? '–' : c > 0 ? `▲ ${pct(c)}` : c < 0 ? `▼ ${pct(-c)}` : '0%');

export async function analyticsTab(ctx) {
  const period = PERIODS.some(([k]) => k === ctx.query.period) ? ctx.query.period : 'month';
  const a = await api('GET', '/admin/analytics/services', { query: { period } });
  const noun = NOUN[period];
  const labels = a.buckets.map((b) => bucketLabel(period, b.start));
  const peak = Math.max(1, ...a.services.flatMap((s) => s.series));
  const level = (n) => (n === 0 ? 0 : Math.min(5, Math.ceil((n / peak) * 5)));

  const toggle = h('div', { class: 'tabs sub-tabs', role: 'group', 'aria-label': 'Period' },
    PERIODS.map(([k, text]) => h('a', { class: `tab${period === k ? ' on' : ''}`, href: `#/admin?tab=analytics&period=${k}` }, text)));

  if (a.totals.orders === 0) {
    return h('div', {}, toggle, h('div', { class: 'card empty' }, h('p', {}, 'No paid orders in this period yet.'), h('p', { class: 'muted small' }, 'To see the dashboard with dummy data on your own computer, run: npm run db:demo')));
  }

  const headline = h('div', { class: 'card', 'data-top': a.top?.slug ?? '' },
    h('div', { class: 'muted small' }, `Last ${a.buckets.length} ${noun}s · ${labels[0]} to ${labels[labels.length - 1]}${''}`),
    a.top ? h('h2', {}, `Most ordered: ${a.top.name}`) : null,
    h('p', {}, a.top ? `${a.top.orders} of ${a.totals.orders} orders (${pct(a.top.share)}). ` : '', `Booking value ${money(a.totals.valueCents)}; ${a.totals.cancelled} cancelled and refunded.`),
    h('p', { class: 'muted small' }, 'An order is a booking that was paid for. Weeks start on Monday; dates are Malaysia time and follow the day the order was placed. The latest column is still in progress.'));

  // ranking
  const max = Math.max(1, ...a.services.map((s) => s.orders));
  const ranking = h('div', { class: 'card' }, h('h2', {}, `Ranking over these ${a.buckets.length} ${noun}s`),
    h('ol', { class: 'rank-list' }, a.services.map((s, i) => {
      const bar = h('div', { class: 'rank-bar' });
      bar.style.width = `${Math.max(s.orders ? 2 : 0, Math.round((s.orders / max) * 100))}%`;
      return h('li', { 'data-rank': s.slug },
        h('div', { class: 'rank-head' }, h('span', {}, `${i + 1}. ${s.name}`, s.active ? null : h('span', { class: 'muted small' }, ' (off)')),
          h('span', { class: 'rank-num' }, `${s.orders} orders · ${pct(s.share)}`)),
        h('div', { class: 'rank-track' }, bar),
        h('div', { class: 'muted small' }, `${money(s.valueCents)} · latest ${noun} ${arrow(s.change)}${s.cancelled ? ` · ${s.cancelled} cancelled` : ''}`));
    })));

  // trend table: one row per service, one column per period
  const head = h('tr', {}, h('th', {}, 'Service'), labels.map((l, i) => h('th', { class: a.buckets[i].current ? 'cur' : '' }, l)), h('th', {}, 'Total'));
  const body = a.services.map((s) => h('tr', { 'data-trend': s.slug },
    h('th', { scope: 'row' }, s.name),
    s.series.map((n) => h('td', { class: 'heat', 'data-level': String(level(n)) }, n ? String(n) : '·')),
    h('td', {}, h('strong', {}, String(s.orders)))));
  const totals = h('tr', { class: 'total-row' }, h('th', { scope: 'row' }, 'All services'), a.totals.perBucket.map((n) => h('td', {}, String(n))), h('td', {}, h('strong', {}, String(a.totals.orders))));
  const best = h('tr', { class: 'best-row' }, h('th', { scope: 'row' }, `Top each ${noun}`), a.topPerBucket.map((t) => h('td', { class: 'small', title: t ? `${t.name}: ${t.orders}` : '' }, t ? t.name.split(/[ &,]/)[0] : '–')), h('td', {}));
  const trend = h('div', { class: 'card' }, h('h2', {}, `Orders per ${noun}`), h('div', { class: 'table-scroll' }, h('table', { class: 'mini trend' }, h('thead', {}, head), h('tbody', {}, body, totals, best))));

  return h('div', {}, toggle, headline, ranking, trend);
}
