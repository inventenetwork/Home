import { api } from '../api.js';
import { fmtDuration, t } from '../i18n.js';
import { banner, errText, fmtWhen, h, money, statusBadge, toast } from '../ui.js';
import { payoutsTab, providersTab } from './admin-providers.js';
import { analyticsTab } from './admin-analytics.js';
import { disputesTab } from './extras.js';
import { auditTab, handoverTab, overviewTab, servicesTab, settingsTab, usersTab } from './admin-panel.js';
import { guard } from './provider.js';

const payText = (p) => {
  if (!p) return t('adm.pay.none');
  const base = { pending: 'adm.pay.pending', failed: 'adm.pay.failed', held: 'adm.pay.held', released: 'adm.pay.held', refunded: 'adm.pay.refunded' }[p.status];
  return t(p.refundedCents > 0 && p.status !== 'refunded' ? 'adm.pay.partial' : base ?? 'adm.pay.none');
};

const humanize = (slug) => String(slug).replace(/-/g, ' ');

/** A small bookings desk: the fallback for bookings nobody accepted, plus the development "mark as paid" button. The full admin panel is step 9. */
export async function adminPage(ctx) {
  const blocked = guard(ctx, 'admin');
  if (blocked) return blocked;

  const tab = ['attention', 'all', 'providers', 'payouts', 'disputes', 'handover', 'users', 'services', 'analytics', 'settings', 'audit'].includes(ctx.query.tab) ? ctx.query.tab : 'overview';
  const bookingTab = tab === 'all' || tab === 'attention';
  const { bookings } = bookingTab ? await api('GET', '/admin/bookings', { query: { limit: 100, attention: tab === 'attention' ? 1 : undefined } }) : { bookings: [] };
  const message = h('div');

  async function run(fn, okText) {
    message.replaceChildren();
    try {
      const r = await fn();
      toast(typeof okText === 'function' ? okText(r) : okText, 'success');
      ctx.rerender();
    } catch (err) {
      message.replaceChildren(banner('error', errText(err)));
    }
  }

  function card(b) {
    const panel = h('div');
    const actions = h('div', { class: 'actions' });

    function showCancelAsk() {
      actions.replaceChildren(
        h('span', { class: 'confirm-ask' }, t('adm.cancel.ask')),
        h('button', { class: 'btn btn-danger', type: 'button', onclick: () => run(() => api('POST', `/admin/bookings/${b.id}/status`, { body: { status: 'cancelled', reason: 'admin_cancelled' } }), t('adm.cancelled')) }, t('bk.cancel.yes')),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: draw }, t('common.back')),
      );
    }

    async function showAssign() {
      panel.replaceChildren(h('p', { class: 'muted' }, '…'));
      try {
        const { candidates } = await api('GET', `/admin/bookings/${b.id}/candidates`);
        if (!candidates.length) return panel.replaceChildren(banner('info', t('adm.assign.none')));
        const select = h('select', { 'aria-label': t('adm.assign.choose') },
          h('option', { value: '' }, t('adm.assign.choose')),
          candidates.map((c) => h('option', { value: c.providerId }, `${c.name ?? c.email} (${c.ratingCount ? c.ratingAvg.toFixed(1) : 'new'})`)));
        panel.replaceChildren(h('div', { class: 'actions' }, select,
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => select.value && run(() => api('POST', `/admin/bookings/${b.id}/assign`, { body: { providerId: select.value } }), t('adm.assigned')) }, t('adm.assign.confirm'))));
      } catch (err) {
        panel.replaceChildren(banner('error', errText(err)));
      }
    }

    function draw() {
      panel.replaceChildren();
      actions.replaceChildren(...[
        b.payment?.refundPending
          ? h('button', { class: 'btn btn-primary', type: 'button', 'data-retry-refund': b.id, onclick: () => run(() => api('POST', `/admin/bookings/${b.id}/refund/retry`, { body: {} }), t('adm.refund.retried')) }, t('adm.refund.retry'))
          : null,
        b.status === 'pending' || b.status === 'offered' ? h('button', { class: 'btn btn-ghost', type: 'button', 'data-assign': b.id, onclick: showAssign }, t('adm.assign')) : null,
        b.status === 'pending' || b.status === 'offered' ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: showCancelAsk }, t('adm.cancel')) : null,
      ].filter(Boolean));
    }
    draw();

    return h('div', { class: 'card', 'data-booking': b.id },
      h('div', { class: 'detail-head' },
        h('div', {},
          h('strong', { class: 'cap' }, humanize(b.service)),
          h('div', {}, `${fmtWhen(b.scheduledAt)} · ${fmtDuration(b.durationMinutes)}`),
          h('div', { class: 'muted small' }, `${b.area ? humanize(b.area) : '—'} · ${money(b.totalCents)}`),
        ),
        h('div', { class: 'right' }, statusBadge(b.status), b.needsAttention ? h('div', { class: 'badge badge-disputed attn' }, t('adm.attention')) : null),
      ),
      h('dl', { class: 'facts' },
        h('div', { class: 'row' }, h('dt', {}, t('adm.customer')), h('dd', {}, b.customerEmail)),
        h('div', { class: 'row' }, h('dt', {}, t('adm.provider')), h('dd', {}, b.providerEmail ?? '—')),
        h('div', { class: 'row' }, h('dt', {}, t('adm.payment')), h('dd', {}, [payText(b.payment), b.payment?.refundPending ? h('div', { class: 'muted small' }, t('adm.refund.pending')) : null].filter(Boolean))),
        b.status === 'offered' || b.offers.declined || b.offers.expired
          ? h('div', { class: 'row' }, h('dt', {}, ''), h('dd', { class: 'muted small' }, t('adm.offers', b.offers)))
          : null,
      ),
      actions, panel,
    );
  }

  return h('div', { class: 'container narrow-lg' },
    h('h1', {}, t('adm.title')),
    h('div', { class: 'tabs', role: 'group' },
      [['overview', 'Overview'], ['attention', t('adm.tab.attention')], ['all', t('adm.tab.all')], ['handover', 'Handover'], ['disputes', t('adm.tab.disputes')], ['providers', t('adm.tab.providers')], ['payouts', t('adm.tab.payouts')], ['users', 'Users'], ['services', 'Services'], ['analytics', 'Analytics'], ['settings', 'Settings'], ['audit', 'Audit log']]
        .map(([key, text]) => h('a', { class: `tab${tab === key ? ' on' : ''}`, href: `#/admin?tab=${key}` }, text))),
    message,
    tab === 'providers' ? await providersTab(ctx, message, run) : null,
    tab === 'payouts' ? await payoutsTab(ctx, message, run) : null,
    tab === 'disputes' ? await disputesTab(ctx, message, run) : null,
    tab === 'overview' ? await overviewTab(ctx) : null,
    tab === 'handover' ? await handoverTab(ctx, message, run) : null,
    tab === 'users' ? await usersTab(ctx, message, run) : null,
    tab === 'analytics' ? await analyticsTab(ctx) : null,
    tab === 'services' ? await servicesTab(ctx, message) : null,
    tab === 'settings' ? await settingsTab(ctx, message) : null,
    tab === 'audit' ? await auditTab(ctx, message) : null,
    !bookingTab ? null : bookings.length ? h('div', { class: 'list' }, bookings.map(card)) : h('div', { class: 'card empty' }, h('p', {}, t(tab === 'attention' ? 'adm.empty.attention' : 'adm.empty'))),
  );
}
