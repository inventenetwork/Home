// Step 9 admin tabs: overview and reports, handover, users, settings, audit log. English only, like the other admin screens.
import { api, apiBlobUrl } from '../api.js';
import { banner, errText, fmtWhen, h, money, mytDate, toast } from '../ui.js';

const label = (s) => String(s).replace(/[._-]/g, ' ');
const stat = (key, text, cls = '', hint = '') =>
  h('div', { class: `stat ${cls}`, 'data-stat': key }, h('div', { class: 'stat-label' }, label(key)), h('div', { class: 'stat-value' }, text), hint ? h('div', { class: 'muted small' }, hint) : null);

// ───────────── overview ─────────────

export async function overviewTab(ctx) {
  const days = [7, 30, 90].includes(Number(ctx.query.days)) ? Number(ctx.query.days) : 30;
  const o = await api('GET', '/admin/overview', { query: { days } });

  const link = (n, text, tab) => (n > 0 ? h('li', { 'data-todo': tab }, h('a', { href: `#/admin?tab=${tab}` }, `${n} ${text}`)) : null);
  const todo = [
    link(o.todo.needsProvider, 'job(s) need a provider', 'attention'),
    link(o.todo.openDisputes, 'open dispute(s)', 'disputes'),
    link(o.todo.applicationsWaiting, 'provider application(s) to review', 'providers'),
    o.todo.payoutsRequested ? h('li', { 'data-todo': 'payouts' }, h('a', { href: '#/admin?tab=payouts' }, `Provider withdrawals to pay: ${money(o.money.requestedPayoutsCents)}`)) : null,
  ].filter(Boolean);

  // Bars are plain elements sized from script (the strict CSP forbids style attributes).
  const max = Math.max(1, ...o.daily.map((d) => d.bookings));
  const bars = h('div', { class: 'bars', role: 'img', 'aria-label': `Bookings per day, last ${days} days. Busiest day: ${max}.` },
    o.daily.map((d) => {
      const bar = h('div', { class: 'chart-bar', title: `${d.date}: ${d.bookings} booking(s), ${money(d.valueCents)}` });
      bar.style.height = `${Math.max(d.bookings ? 6 : 1, Math.round((d.bookings / max) * 100))}%`;
      return bar;
    }));

  const table = (heads, rows) =>
    rows.length
      ? h('table', { class: 'mini' }, h('thead', {}, h('tr', {}, heads.map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c))))))
      : h('p', { class: 'muted small' }, 'Nothing yet.');

  // CSV export
  const from = h('input', { type: 'date', id: 'csv-from', value: mytDate(-days), 'aria-label': 'From' });
  const to = h('input', { type: 'date', id: 'csv-to', value: mytDate(0), 'aria-label': 'To' });
  const csvMsg = h('div');
  const csvBtn = h('button', { class: 'btn btn-ghost', type: 'button', 'data-csv': true, onclick: async () => {
    csvMsg.replaceChildren();
    csvBtn.disabled = true;
    try {
      const url = await apiBlobUrl(`/admin/reports/bookings.csv?from=${from.value}&to=${to.value}`);
      const a = h('a', { href: url, download: `home360-bookings-${from.value}-to-${to.value}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      csvMsg.replaceChildren(banner('error', e.status === 400 ? 'Check the dates (at most 366 days, end after start).' : errText(e)));
    }
    csvBtn.disabled = false;
  } }, 'Download CSV');

  return h('div', {},
    h('div', { class: 'tabs sub-tabs', role: 'group', 'aria-label': 'Period' },
      [7, 30, 90].map((d) => h('a', { class: `tab${d === days ? ' on' : ''}`, href: `#/admin?tab=overview&days=${d}` }, `Last ${d} days`))),
    h('div', { class: 'card' }, h('h2', {}, 'Needs you'), todo.length ? h('ul', { class: 'plain-list' }, todo) : h('p', { class: 'muted', 'data-all-clear': true }, 'Nothing needs your attention.')),
    h('div', { class: 'stat-grid' },
      stat('bookings', String(o.bookings.total), 'stat-main', `${o.bookings.completed} done, ${o.bookings.cancelled} cancelled`),
      stat('paid by customers', money(o.money.paidCents)),
      stat('refunded', money(o.money.refundedCents)),
      stat('our commission', money(o.money.commissionCents)),
      stat('owed to providers', money(o.money.owedToProvidersCents), '', `${money(o.money.requestedPayoutsCents)} requested`),
      stat('new customers', String(o.users.customers)),
      stat('new providers', String(o.users.providers), '', `${o.providers.approved} approved in total`),
      stat('average rating', o.reviews.count ? o.reviews.average.toFixed(2) : '—', '', `${o.reviews.count} review(s)`)),
    h('div', { class: 'card' }, h('h2', {}, 'Bookings per day'), bars, h('div', { class: 'bars-axis muted small' }, h('span', {}, o.daily[0]?.date ?? ''), h('span', {}, o.daily.at(-1)?.date ?? ''))),
    h('div', { class: 'card' }, h('h2', {}, 'By service'), table(['Service', 'Bookings', 'Value'], o.byService.map((s) => [s.name, String(s.bookings), money(s.valueCents)]))),
    h('div', { class: 'card' }, h('h2', {}, 'By area'), table(['Area', 'Bookings'], o.byArea.map((a) => [a.name, String(a.bookings)]))),
    h('div', { class: 'card' }, h('h2', {}, 'Busiest providers'), table(['Provider', 'Jobs', 'Rating'], o.topProviders.map((p) => [p.name, String(p.jobs), p.ratingCount ? `${p.rating.toFixed(1)} (${p.ratingCount})` : 'new']))),
    h('div', { class: 'card' }, h('h2', {}, 'Export for your accountant'), h('p', { class: 'muted small' }, 'One row per booking by job date (Malaysia time): amounts, refunds, commission and payout status. Opens in Excel.'),
      h('div', { class: 'actions' }, from, to, csvBtn), csvMsg));
}

// ───────────── handover ─────────────

export async function handoverTab(ctx, message, run) {
  const { jobs } = await api('GET', '/admin/handover');
  function card(j) {
    const panel = h('div');
    const actions = h('div', { class: 'actions' });
    const draw = () => actions.replaceChildren(
      h('button', { class: 'btn btn-primary', type: 'button', 'data-rematch': j.bookingId, onclick: ask }, 'Send back to matching'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: assign }, 'Assign by hand'));
    function ask() {
      actions.replaceChildren(h('span', { class: 'confirm-ask' }, 'Take this job from the provider and offer it to others?'),
        h('button', { class: 'btn btn-primary', type: 'button', 'data-rematch-yes': j.bookingId, onclick: () => run(() => api('POST', `/admin/bookings/${j.bookingId}/rematch`, { body: {} }), (r) => `Offered to ${r.offered} provider(s).`) }, 'Yes, send it'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: draw }, 'Back'));
    }
    async function assign() {
      panel.replaceChildren(h('p', { class: 'muted' }, '…'));
      try {
        const { candidates } = await api('GET', `/admin/bookings/${j.bookingId}/candidates`);
        if (!candidates.length) return panel.replaceChildren(banner('info', 'No free provider matches this job right now.'));
        const select = h('select', { 'aria-label': 'Provider' }, h('option', { value: '' }, 'Choose a provider'), candidates.map((c) => h('option', { value: c.providerId }, c.name ?? c.email)));
        panel.replaceChildren(h('div', { class: 'actions' }, select, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => select.value && run(() => api('POST', `/admin/bookings/${j.bookingId}/assign`, { body: { providerId: select.value } }), 'Assigned.') }, 'Assign')));
      } catch (e) { panel.replaceChildren(banner('error', errText(e))); }
    }
    draw();
    return h('div', { class: 'card', 'data-handover': j.bookingId },
      h('div', { class: 'detail-head' },
        h('div', {}, h('strong', {}, j.service), h('div', {}, fmtWhen(j.scheduledAt)), h('div', { class: 'muted small' }, `${j.area ?? '—'} · ${j.customer}`)),
        h('span', { class: 'badge badge-disputed' }, j.reason === 'day_off' ? 'Provider day off' : 'Provider suspended')),
      h('p', { class: 'small' }, `Provider: ${j.provider}`), actions, panel);
  }
  return h('div', {}, h('p', { class: 'muted small' }, 'Confirmed jobs whose provider can no longer do them.'),
    jobs.length ? h('div', { class: 'list' }, jobs.map(card)) : h('div', { class: 'card empty' }, h('p', {}, 'No jobs need a new provider.')));
}

// ───────────── users ─────────────

export async function usersTab(ctx, message, run) {
  const q = ctx.query.q ?? '';
  const role = ctx.query.role ?? '';
  const status = ctx.query.status ?? '';
  let offset = 0;
  const list = h('div', { class: 'list' });
  const more = h('div', { class: 'actions' });

  const form = h('form', { class: 'filters', role: 'search', onsubmit: (e) => {
    e.preventDefault();
    const p = new URLSearchParams({ tab: 'users' });
    for (const [k, el] of [['q', search], ['role', roleSel], ['status', statusSel]]) if (el.value) p.set(k, el.value);
    ctx.navigate(`#/admin?${p}`);
  } });
  const search = h('input', { type: 'search', id: 'user-q', placeholder: 'Email, name or phone', value: q, 'aria-label': 'Search users', maxlength: 100 });
  const sel = (id, opts, val, aria) => h('select', { id, 'aria-label': aria }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
  const roleSel = sel('user-role', [['', 'Any role'], ['customer', 'Customers'], ['provider', 'Providers'], ['admin', 'Admins']], role, 'Role');
  const statusSel = sel('user-status', [['', 'Any status'], ['active', 'Active'], ['suspended', 'Suspended']], status, 'Status');
  form.append(search, roleSel, statusSel, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Search'));

  function card(u) {
    const detail = h('div');
    const head = h('div', { class: 'detail-head' },
      h('div', {}, h('strong', {}, u.fullName ?? u.email), h('div', { class: 'muted small' }, u.fullName ? u.email : ''), h('div', { class: 'muted small' }, `${u.role} · joined ${new Date(u.createdAt).toLocaleDateString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })} · ${u.role === 'provider' ? `${u.jobs} job(s)` : `${u.bookings} booking(s)`}`)),
      h('span', { class: `badge ${u.status === 'active' ? 'badge-completed' : 'badge-disputed'}` }, u.status));
    const btn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: open }, 'Details');
    async function open() {
      btn.disabled = true;
      try {
        const d = await api('GET', `/admin/users/${u.id}`);
        const reason = h('input', { type: 'text', maxlength: 300, placeholder: 'Reason (shown only to admins)', 'aria-label': 'Reason' });
        const actions = h('div', { class: 'actions' });
        if (d.role !== 'admin' && d.status === 'active') {
          actions.append(reason, h('button', { class: 'btn btn-danger', type: 'button', 'data-suspend': u.id, onclick: () => {
            if (reason.value.trim().length < 3) return message.replaceChildren(banner('error', 'Give a short reason first.'));
            run(() => api('POST', `/admin/users/${u.id}/suspend`, { body: { reason: reason.value.trim() } }), 'Account suspended.');
          } }, 'Suspend'));
        } else if (d.status === 'suspended') {
          actions.append(h('button', { class: 'btn btn-primary', type: 'button', 'data-reinstate': u.id, onclick: () => run(() => api('POST', `/admin/users/${u.id}/reinstate`, { body: {} }), 'Account reinstated.') }, 'Reinstate'));
        }
        detail.replaceChildren(h('div', { class: 'admin-detail' },
          h('dl', { class: 'facts' },
            h('div', { class: 'row' }, h('dt', {}, 'Phone'), h('dd', {}, d.phone ?? '—')),
            h('div', { class: 'row' }, h('dt', {}, 'Consent (PDPA)'), h('dd', {}, d.consentAt ? fmtWhen(d.consentAt) : '—')),
            d.suspendedReason ? h('div', { class: 'row' }, h('dt', {}, 'Suspended because'), h('dd', {}, d.suspendedReason)) : null),
          h('h3', {}, 'Recent bookings'),
          d.recentBookings.length ? h('ul', { class: 'plain-list' }, d.recentBookings.map((b) => h('li', {}, h('span', {}, `${b.service} · ${fmtWhen(b.scheduledAt)}`), h('span', { class: 'muted small' }, `${b.status} · ${money(b.totalCents)}`)))) : h('p', { class: 'muted small' }, 'None.'),
          actions));
        btn.remove();
      } catch (e) { message.replaceChildren(banner('error', errText(e))); btn.disabled = false; }
    }
    return h('div', { class: 'card', 'data-user': u.id }, head, h('div', { class: 'actions' }, btn), detail);
  }

  async function load() {
    const r = await api('GET', '/admin/users', { query: { q: q || undefined, role: role || undefined, status: status || undefined, limit: 25, offset } });
    if (offset === 0 && !r.users.length) list.replaceChildren(h('div', { class: 'card empty' }, h('p', {}, 'No users match.')));
    else list.append(...r.users.map(card));
    offset += r.users.length;
    more.replaceChildren(...(r.hasMore ? [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => load().catch((e) => message.replaceChildren(banner('error', errText(e)))) }, 'Show more')] : []));
  }
  await load();
  return h('div', {}, form, list, more);
}

// ───────────── settings ─────────────

const GROUPS = { booking: 'Booking rules', matching: 'Matching', money: 'Money', provider: 'Providers and payouts' };

export async function settingsTab(ctx, message) {
  const { settings } = await api('GET', '/admin/settings');
  function row(s) {
    const input = s.kind === 'bool'
      ? h('select', { id: `set-${s.key}`, 'aria-label': s.label }, ['true', 'false'].map((v) => h('option', { value: v, selected: v === s.value }, v === 'true' ? 'Yes' : 'No')))
      : h('input', { id: `set-${s.key}`, type: 'text', inputmode: s.kind === 'hhmm' ? 'numeric' : 'decimal', value: s.value, maxlength: 20, 'aria-label': s.label });
    const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-save-setting': s.key, onclick: async () => {
      save.disabled = true;
      message.replaceChildren();
      try {
        const r = await api('PUT', `/admin/settings/${s.key}`, { body: { value: input.value } });
        input.value = r.value;
        toast(`${label(s.key)} saved.`, 'success');
      } catch (e) {
        message.replaceChildren(banner('error', e.code === 'invalid_value' ? e.message : errText(e)));
      }
      save.disabled = false;
    } }, 'Save');
    return h('div', { class: 'setting-row', 'data-setting': s.key }, h('label', { for: `set-${s.key}` }, s.label, h('div', { class: 'muted small' }, s.key)), input, save);
  }
  return h('div', {}, h('p', { class: 'muted small' }, 'Changes apply immediately to new bookings and payouts. Every change is written to the audit log.'),
    Object.entries(GROUPS).map(([g, title]) => h('div', { class: 'card' }, h('h2', {}, title), settings.filter((s) => s.group === g).map(row))));
}

// ───────────── audit log ─────────────

export async function auditTab(ctx, message) {
  const action = ctx.query.action ?? '';
  const list = h('div', { class: 'list' });
  const more = h('div', { class: 'actions' });
  const input = h('input', { type: 'text', id: 'audit-action', placeholder: 'Filter by action, e.g. settings. or provider.', value: action, maxlength: 60, 'aria-label': 'Action filter' });
  const form = h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); ctx.navigate(`#/admin?tab=audit${input.value.trim() ? `&action=${encodeURIComponent(input.value.trim())}` : ''}`); } }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Filter'));
  let before = null;
  const entry = (e) => h('div', { class: 'card audit-entry', 'data-audit': e.action },
    h('div', { class: 'detail-head' }, h('strong', {}, e.action), h('span', { class: 'muted small' }, new Date(e.at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour12: false }))),
    h('div', { class: 'small' }, `${e.actor}${e.entity ? ` → ${e.entity} ${String(e.entityId ?? '').slice(0, 13)}` : ''}`),
    e.detail && Object.keys(e.detail).length ? h('code', { class: 'audit-detail' }, JSON.stringify(e.detail)) : null);
  async function load() {
    const r = await api('GET', '/admin/audit', { query: { action: action || undefined, before: before ?? undefined, limit: 30 } });
    if (!before && !r.entries.length) list.replaceChildren(h('div', { class: 'card empty' }, h('p', {}, 'No entries.')));
    else list.append(...r.entries.map(entry));
    before = r.next;
    more.replaceChildren(...(r.next ? [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => load().catch((e) => message.replaceChildren(banner('error', errText(e)))) }, 'Older')] : []));
  }
  await load();
  return h('div', {}, form, list, more);
}

// ───────────── services and prices ─────────────

const toCents = (text) => {
  const v = Number(String(text).replace(/^RM\s*/i, '').replace(/,/g, '').trim());
  return Number.isFinite(v) && v >= 0 && v < 100000 ? Math.round(v * 100) : null;
};
const rm = (cents) => (cents / 100).toFixed(2);

/** Switch services on or off and edit prices. Customers only see a service when it is on and a provider with its skill covers their area. */
export async function servicesTab(ctx, message) {
  const { services } = await api('GET', '/admin/services');

  const priceBox = (id, cents, aria) => h('input', { type: 'text', inputmode: 'decimal', id, value: rm(cents), maxlength: 9, 'aria-label': aria, class: 'price-input' });

  function serviceCard(s) {
    const hasBase = s.pricingModel === 'hourly' || (s.pricingModel === 'per_unit' && s.basePriceCents > 0);
    const base = hasBase ? priceBox(`base-${s.slug}`, s.basePriceCents, `${s.nameEn} price`) : null;
    const activeBtn = h('button', { class: `btn btn-sm ${s.active ? 'btn-ghost' : 'btn-primary'}`, type: 'button', 'data-toggle-service': s.slug, onclick: async () => {
      activeBtn.disabled = true;
      message.replaceChildren();
      try {
        await api('PATCH', `/admin/services/${s.id}`, { body: { active: !s.active } });
        toast(`${s.nameEn} is now ${s.active ? 'off' : 'on'}.`, 'success');
        ctx.rerender();
      } catch (e) {
        message.replaceChildren(banner('error', errText(e)));
        activeBtn.disabled = false;
      }
    } }, s.active ? 'Switch off' : 'Switch on');

    const saveBase = base && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-save-base': s.slug, onclick: async () => {
      const cents = toCents(base.value);
      if (cents === null) return message.replaceChildren(banner('error', 'Enter a price like 30 or 30.50.'));
      message.replaceChildren();
      try { await api('PATCH', `/admin/services/${s.id}`, { body: { basePriceCents: cents } }); toast(`${s.nameEn} price saved.`, 'success'); }
      catch (e) { message.replaceChildren(banner('error', errText(e))); }
    } }, 'Save');

    const optionRow = (o) => {
      const box = priceBox(`opt-${s.slug}-${o.groupKey}-${o.code}`, o.priceCents, `${o.labelEn} price`);
      const save = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-save-option': `${s.slug}:${o.code}`, onclick: async () => {
        const cents = toCents(box.value);
        if (cents === null) return message.replaceChildren(banner('error', 'Enter a price like 30 or 30.50.'));
        message.replaceChildren();
        try { await api('PATCH', `/admin/options/${o.id}`, { body: { priceCents: cents } }); toast(`${o.labelEn} price saved.`, 'success'); }
        catch (e) { message.replaceChildren(banner('error', errText(e))); }
      } }, 'Save');
      return h('div', { class: 'setting-row' }, h('label', { for: box.id }, o.labelEn, h('div', { class: 'muted small' }, `${o.groupKey}${o.perUnit ? ' · per ' + (s.unitLabel ?? 'unit') : ''}${o.active ? '' : ' · hidden'}`)), h('span', {}, 'RM ', box), save);
    };

    return h('details', { class: 'card service-admin', 'data-service': s.slug },
      h('summary', {}, h('strong', {}, s.nameEn), ' ', h('span', { class: `badge ${s.active ? 'badge-prov-approved' : 'badge-prov-pending'}` }, s.active ? 'on' : 'off'),
        h('span', { class: 'muted small' }, ` ${s.pricingModel.replace('_', ' ')}${s.unitLabel ? ' · per ' + s.unitLabel : ''}`)),
      h('p', { class: 'muted small' }, s.descriptionEn ?? ''),
      s.active ? null : h('p', { class: 'small' }, 'Switched off: customers cannot see or book it. Before switching on, check the prices below and make sure some providers have this service ticked (Providers → Review → Services).'),
      hasBase ? h('div', { class: 'setting-row' }, h('label', { for: base.id }, s.pricingModel === 'hourly' ? `Price per ${s.unitLabel ?? 'unit'}` : 'Base price'), h('span', {}, 'RM ', base), saveBase) : null,
      s.options.map(optionRow),
      h('div', { class: 'actions' }, activeBtn));
  }

  const off = services.filter((s) => !s.active);
  const allOn = off.length === 0 ? null : h('button', { class: 'btn btn-primary', type: 'button', 'data-switch-all': true, onclick: async (ev) => {
    ev.currentTarget.disabled = true;
    message.replaceChildren();
    try {
      for (const s of off) await api('PATCH', `/admin/services/${s.id}`, { body: { active: true } });
      toast(`${off.length} service(s) switched on.`, 'success');
      ctx.rerender();
    } catch (e) {
      message.replaceChildren(banner('error', errText(e)));
      ctx.rerender();
    }
  } }, `Switch everything on (${off.length} off)`);
  return h('div', {}, allOn ? h('div', { class: 'actions' }, allOn) : null, h('p', { class: 'muted small' }, 'Prices are in Malaysian Ringgit, before SST. A price change applies to new bookings at once; existing bookings keep their price. Every change is written to the audit log.'),
    services.map(serviceCard));
}
