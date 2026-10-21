import { protectedImg } from '../photos.js';
import { api, isLoggedIn } from '../api.js';
import { fmtDay, fmtDuration, hasKey, t } from '../i18n.js';
import { banner, config, errText, fmtClock, h, money, statusBadge, toast } from '../ui.js';
import { saveDraft } from './book.js';
import { chatPanel, disputeBox, loadUnread, reviewBox } from './extras.js';

const CANCELLABLE = new Set(['pending', 'offered', 'confirmed']);
const when = (b) => `${fmtDay(b.localDate, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, ${b.localTime}`;
const addressLine = (a) => [a.line1, a.line2, `${a.postcode}${a.area ? ` ${a.area}` : ''}`].filter(Boolean).join(', ');

function loginRedirect(ctx) {
  ctx.navigate(`#/login?next=${encodeURIComponent(location.hash)}`);
  return h('div');
}

export async function bookingsPage(ctx) {
  if (!isLoggedIn()) return loginRedirect(ctx);
  const { bookings } = await api('GET', '/bookings', { query: { limit: 50 } });

  const body = bookings.length
    ? h('div', { class: 'list' },
        bookings.map((b) =>
          h('a', { class: 'card booking-card', href: `#/bookings/${b.id}` },
            h('div', {},
              h('strong', {}, b.service.name),
              h('div', { class: 'muted' }, when(b)),
              h('div', { class: 'muted small' }, b.address.area ?? b.address.line1),
            ),
            h('div', { class: 'right' }, statusBadge(b.status), h('div', { class: 'amt' }, money(b.pricing.totalCents))),
          )))
    : h('div', { class: 'card empty' }, h('p', {}, t('bk.empty')), h('a', { class: 'btn btn-primary', href: '#/' }, t('bk.cta')));

  return h('div', { class: 'container narrow-lg' }, h('h1', {}, t('bk.title')), body);
}

export async function bookingDetailPage(ctx) {
  if (!isLoggedIn()) return loginRedirect(ctx);
  const b = await api('GET', `/bookings/${ctx.params[0]}`);
  const isNew = ctx.query.new === '1';
  const unread = b.provider ? (await loadUnread())[b.id] ?? 0 : 0;

  let confirming = false;
  let busy = false;
  const actions = h('div', { class: 'actions' });
  const errorBox = h('div');

  async function cancel() {
    busy = true;
    errorBox.replaceChildren();
    drawActions();
    try {
      await api('POST', `/bookings/${b.id}/cancel`, { body: {} });
      toast(t('bk.cancelled.toast'), 'success');
      ctx.navigate(`#/bookings/${b.id}`); // same page: re-renders with the cancelled status
      return;
    } catch (err) {
      errorBox.replaceChildren(banner('error', errText(err)));
      confirming = false;
    }
    busy = false;
    drawActions();
  }

  function rebook() {
    const options = {};
    for (const o of b.rebook.options) options[o.group] = o.code;
    saveDraft(b.rebook.serviceSlug, { units: b.rebook.units, options, addressId: b.rebook.addressId });
    ctx.navigate(`#/book/${b.rebook.serviceSlug}`);
  }

  function drawActions() {
    const kids = [];
    if (confirming) {
      kids.push(
        h('span', { class: 'confirm-ask' }, t('bk.cancel.ask')),
        h('button', { class: 'btn btn-danger', type: 'button', disabled: busy, onclick: cancel }, t('bk.cancel.yes')),
        h('button', { class: 'btn btn-ghost', type: 'button', disabled: busy, onclick: () => { confirming = false; drawActions(); } }, t('bk.cancel.no')),
      );
    } else {
      if (CANCELLABLE.has(b.status)) {
        kids.push(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { confirming = true; drawActions(); } }, t('bk.cancel')));
      }
      kids.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: rebook }, t('bk.rebook')));
    }
    actions.replaceChildren(...kids);
  }
  drawActions();

  // Keep an open booking fresh: when a provider accepts, the customer sees it without reloading.
  if (['pending', 'offered', 'confirmed', 'on_the_way', 'in_progress'].includes(b.status)) {
    const timer = setInterval(async () => {
      try {
        const f = await api('GET', `/bookings/${b.id}`);
        if (f.status !== b.status || f.provider?.name !== b.provider?.name || f.payment?.status !== b.payment?.status) ctx.rerender();
      } catch { /* try again next time */ }
    }, 20_000);
    ctx.onCleanup(() => clearInterval(timer));
  }

  const holdUntil = new Date(new Date(b.createdAt).getTime() + config.pendingExpiryMinutes * 60_000).toISOString();
  const row = (label, value) => h('div', { class: 'row' }, h('dt', {}, label), h('dd', {}, value));

  // ── paying ──
  const returning = ctx.query.pay === 'return';
  let method = 'fpx';
  let paying = false;
  const payBox = h('div', { class: 'pay-box' });
  const payError = h('div');

  async function startPay() {
    paying = true;
    payError.replaceChildren();
    drawPay();
    try {
      const r = await api('POST', `/bookings/${b.id}/pay`, { body: { method } });
      location.assign(r.redirectUrl); // the gateway's hosted payment page
    } catch (err) {
      paying = false;
      payError.replaceChildren(banner('error', errText(err)));
      drawPay();
    }
  }

  function drawPay() {
    if (b.status !== 'pending') return payBox.replaceChildren();
    const methodRow = (code) =>
      h('label', { class: `opt${method === code ? ' selected' : ''}` },
        h('input', { type: 'radio', name: 'pay-method', value: code, checked: method === code, disabled: paying, onchange: () => { method = code; drawPay(); } }),
        h('span', { class: 'opt-label' }, t(`pay.method.${code}`)));
    payBox.replaceChildren(...[
      h('h2', {}, t('pay.title')),
      config.paymentGateway === 'fake' ? banner('info', t('pay.test')) : null,
      methodRow('fpx'),
      methodRow('ewallet'),
      h('p', { class: 'muted small' }, t('pay.hold', { time: fmtClock(holdUntil) })),
      h('button', { class: 'btn btn-primary btn-block', type: 'button', 'data-pay': b.id, disabled: paying, onclick: startPay },
        paying ? t('pay.redirecting') : t('pay.button', { amount: money(b.pricing.totalCents) })),
    ].filter(Boolean));
  }
  drawPay();

  const DONE = ['offered', 'confirmed', 'on_the_way', 'in_progress', 'completed', 'paid_out'];
  function returnBanner() {
    if (!returning) return null;
    if (DONE.includes(b.status)) return banner('success', t('pay.ok'));
    if (b.status !== 'pending') return null;
    return b.payment?.status === 'pending' ? banner('info', t('pay.waiting')) : banner('error', t('pay.failed'));
  }

  // A real gateway can take a few seconds to tell us. Back from the payment page and still waiting: look again soon.
  if (returning && b.status === 'pending' && b.payment?.status === 'pending') {
    let tries = 0;
    const quick = setInterval(async () => {
      tries += 1;
      try {
        const f = await api('GET', `/bookings/${b.id}`);
        if (f.status !== b.status || f.payment?.status !== b.payment?.status) { clearInterval(quick); ctx.rerender(); }
      } catch { /* try again */ }
      if (tries >= 10) clearInterval(quick);
    }, 3000);
    ctx.onCleanup(() => clearInterval(quick));
  }

  function paymentRow() {
    const p = b.payment;
    if (!p || p.status === 'pending' || p.status === 'failed') return null;
    const amount = money(p.amountCents);
    const text = p.status === 'paid'
      ? `${t('pay.paid', { amount })}${p.method ? ` ${t(`pay.via.${p.method}`)}` : ''}`
      : p.status === 'refunded'
        ? t('pay.refunded', { amount: money(p.refundedCents) })
        : t('pay.partial', { amount, refunded: money(p.refundedCents) });
    return row(t('pay.status'), [text, p.refundPending ? h('div', { class: 'muted small' }, t('pay.refundPending')) : null].filter(Boolean));
  }

  const cancelledText = b.status === 'cancelled'
    ? t(hasKey(`bk.cancelled.${b.cancelledReason}`) ? `bk.cancelled.${b.cancelledReason}` : 'bk.cancelled')
    : null;

  return h('div', { class: 'container narrow-lg' },
    h('a', { class: 'back', href: '#/bookings' }, t('bk.back')),
    returning ? returnBanner() : null,
    isNew && b.status === 'pending' && !returning
      ? banner('success', h('strong', {}, t('bk.new')), h('br'), t('bk.new.hold', { time: fmtClock(holdUntil) }))
      : null,
    h('div', { class: 'card' },
      h('div', { class: 'detail-head' },
        h('div', {}, h('h1', {}, b.service.name), h('p', { class: 'muted small' }, t('bk.ref', { ref: `#${b.id.slice(0, 8).toUpperCase()}` }))),
        statusBadge(b.status),
      ),
      cancelledText ? banner('info', cancelledText) : null,
      h('dl', { class: 'facts' },
        row(t('bk.when'), `${when(b)} · ${fmtDuration(b.durationMinutes)}`),
        row(t('bk.where'), addressLine(b.address)),
        row(t('bk.provider'), b.provider?.name ?? t('bk.provider.none')),
        b.notes ? row(t('bk.notes'), b.notes) : null,
        paymentRow(),
      ),
      b.photos && (b.photos.before || b.photos.after)
        ? [h('h2', {}, t('bk.photos')),
           h('div', { class: 'photo-box', 'data-job-photos': true }, ['before', 'after'].filter((k) => b.photos[k]).map((k) =>
             h('div', { class: 'photo-slot' }, h('div', { class: 'small' }, t(`bk.photo.${k}`)), protectedImg(`/bookings/${b.id}/photos/${k}`, t(`bk.photo.${k}`), ctx.onCleanup, 'thumb thumb-lg'))))]
        : null,
      h('h2', {}, t('bk.price')),
      ...b.pricing.lineItems.map((li) =>
        h('div', { class: 'price-line' }, h('span', {}, li.qty > 1 ? `${li.label} × ${li.qty}` : li.label), h('span', { class: 'amt' }, money(li.amountCents)))),
      b.pricing.sstCents > 0 ? h('div', { class: 'price-line muted' }, h('span', {}, t('sum.sst')), h('span', { class: 'amt' }, money(b.pricing.sstCents))) : null,
      h('div', { class: 'price-line total' }, h('span', {}, t('sum.total')), h('span', { class: 'amt' }, money(b.pricing.totalCents))),
      b.provider && ['confirmed', 'on_the_way', 'in_progress', 'completed', 'disputed', 'paid_out'].includes(b.status) ? chatPanel(ctx, b.id, unread) : null,
      reviewBox(ctx, b),
      disputeBox(ctx, b),
      b.recurringPlanId ? h('p', { class: 'muted small' }, h('a', { href: '#/plans' }, t('plan.part'))) : null,
      payBox,
      payError,
      errorBox,
      actions,
    ),
  );
}
