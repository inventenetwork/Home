// Step 8 screens: chat, reviews, disputes (customer side), recurring plans, provider reviews, admin dispute desk.
import { api, isLoggedIn } from '../api.js';
import { fmtDay, t } from '../i18n.js';
import { protectedImg } from '../photos.js';
import { banner, errText, fmtWhen, h, localeCode, money, toast } from '../ui.js';
import { guard, providerNav } from './provider.js';

const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const timeText = (iso) => new Date(iso).toLocaleTimeString(localeCode(), { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' });

/** How many unread chat messages per booking (empty if the call fails: badges are a nicety). */
export async function loadUnread() {
  try { return (await api('GET', '/chat/unread')).unread; } catch { return {}; }
}

// ───────────── chat ─────────────

/** A collapsible chat with the other side of one booking. Polls while open. */
export function chatPanel(ctx, bookingId, unread = 0) {
  const root = h('div', { class: 'chat', 'data-chat': bookingId });
  const list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' });
  const err = h('div');
  const input = h('textarea', { rows: 2, maxlength: 1000, 'aria-label': t('chat.write'), placeholder: t('chat.write'),
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
  const sendBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => send() }, t('chat.send'));
  const composer = h('div', { class: 'chat-composer' }, input, sendBtn);
  const closed = h('p', { class: 'muted small' }, t('chat.closed'));
  const head = h('button', { class: 'btn btn-ghost', type: 'button', 'aria-expanded': 'false', onclick: toggle },
    t('chat.open'), unread > 0 ? h('span', { class: 'dot', 'data-unread': true }, String(unread)) : null);
  const body = h('div', { class: 'chat-body', hidden: true }, list, err, composer, closed);
  body.hidden = true;
  root.append(head, body);

  let open = false;
  let timer = null;
  let lastCount = -1;

  function draw(data) {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren(...(data.messages.length
      ? data.messages.map((m) => h('div', { class: `msg ${m.mine ? 'mine' : 'theirs'}` }, h('div', { class: 'bubble' }, m.body), h('div', { class: 'when small muted' }, timeText(m.createdAt))))
      : [h('p', { class: 'muted small' }, t('chat.empty', { name: data.otherName ?? '' }))]));
    composer.hidden = !data.canPost;
    closed.hidden = data.canPost;
    if (data.messages.length !== lastCount || nearBottom) list.scrollTop = list.scrollHeight;
    lastCount = data.messages.length;
  }
  async function load() {
    try { draw(await api('GET', `/bookings/${bookingId}/messages`)); err.replaceChildren(); }
    catch (e) { err.replaceChildren(banner('error', errText(e))); }
  }
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      await api('POST', `/bookings/${bookingId}/messages`, { body: { body: text } });
      input.value = '';
      err.replaceChildren();
      await load();
    } catch (e) {
      err.replaceChildren(banner('error', errText(e)));
    }
    sendBtn.disabled = false;
  }
  function toggle() {
    open = !open;
    body.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
    head.querySelector('.dot')?.remove();
    clearInterval(timer);
    if (open) { load(); timer = setInterval(load, 8000); input.focus(); }
  }
  ctx.onCleanup(() => clearInterval(timer));
  return root;
}

// ───────────── customer: review + dispute ─────────────

export function reviewBox(ctx, b) {
  if (b.review) {
    return h('div', { class: 'review-box', 'data-review': true }, h('h2', {}, t('rev.yours')), h('div', { class: 'stars', 'aria-label': `${b.review.rating}/5` }, stars(b.review.rating)), b.review.comment ? h('p', {}, b.review.comment) : null);
  }
  if (!['completed', 'paid_out'].includes(b.status)) return null;
  let rating = 0;
  const err = h('div');
  const comment = h('textarea', { rows: 3, maxlength: 500, 'aria-label': t('rev.comment'), placeholder: t('rev.comment') });
  const row = h('div', { class: 'stars pick', role: 'group', 'aria-label': t('rev.title') });
  const submit = h('button', { class: 'btn btn-primary', type: 'button', disabled: true, onclick: save }, t('rev.submit'));
  const drawStars = () => {
    row.replaceChildren(...[1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', class: `star${n <= rating ? ' on' : ''}`, 'data-star': n, 'aria-pressed': String(n === rating), 'aria-label': `${n}`, onclick: () => { rating = n; submit.disabled = false; drawStars(); } }, n <= rating ? '★' : '☆')));
  };
  drawStars();
  async function save() {
    submit.disabled = true;
    try {
      await api('POST', `/bookings/${b.id}/review`, { body: { rating, ...(comment.value.trim() ? { comment: comment.value.trim() } : {}) } });
      toast(t('rev.thanks'), 'success');
      ctx.rerender();
    } catch (e) {
      err.replaceChildren(banner('error', errText(e)));
      submit.disabled = false;
    }
  }
  return h('div', { class: 'review-box', 'data-review-form': true }, h('h2', {}, t('rev.title')), row, comment, err, h('div', { class: 'actions' }, submit));
}

export function disputeBox(ctx, b) {
  if (b.dispute) {
    const d = b.dispute;
    const key = { open: 'dsp.open', resolved_refund: 'dsp.refund', resolved_redo: 'dsp.redo', rejected: 'dsp.rejected' }[d.status] ?? 'dsp.open';
    return h('div', { class: 'dispute-box', 'data-dispute': d.status }, h('h2', {}, t('dsp.title')), banner(d.status === 'open' ? 'info' : 'success', t(key)), h('p', { class: 'muted small' }, d.reason), d.resolutionNote ? h('p', {}, d.resolutionNote) : null);
  }
  if (!b.disputeUntil) return null;
  const box = h('div', { class: 'dispute-box' });
  const err = h('div');
  const reason = h('textarea', { rows: 3, maxlength: 1000, 'aria-label': t('dsp.reason'), placeholder: t('dsp.reason') });
  const go = h('button', { class: 'btn btn-danger', type: 'button', onclick: send }, t('dsp.submit'));
  async function send() {
    go.disabled = true;
    try {
      await api('POST', `/bookings/${b.id}/dispute`, { body: { reason: reason.value.trim() } });
      toast(t('dsp.sent'), 'success');
      ctx.rerender();
    } catch (e) {
      err.replaceChildren(banner('error', e.code === 'invalid_request' ? t('err.reason_too_short') : errText(e)));
      go.disabled = false;
    }
  }
  const show = () => box.replaceChildren(h('h2', {}, t('dsp.title')), h('p', { class: 'muted small' }, t('dsp.hint', { when: fmtWhen(b.disputeUntil) })), reason, err,
    h('div', { class: 'actions' }, go, h('button', { class: 'btn btn-ghost', type: 'button', onclick: hide }, t('common.back'))));
  const hide = () => box.replaceChildren(h('button', { class: 'btn btn-ghost', type: 'button', 'data-report': true, onclick: show }, t('dsp.report')));
  hide();
  return box;
}

// ───────────── customer: recurring plans ─────────────

const FREQ = { weekly: 'plan.weekly', biweekly: 'plan.biweekly', monthly: 'plan.monthly' };

export async function plansPage(ctx) {
  if (!isLoggedIn()) {
    ctx.navigate(`#/login?next=${encodeURIComponent(location.hash)}`);
    return h('div');
  }
  const { plans } = await api('GET', '/recurring');
  const msg = h('div');
  async function act(fn, ok) {
    msg.replaceChildren();
    try { const r = await fn(); if (ok) toast(ok, 'success'); return r; } catch (e) { msg.replaceChildren(banner('error', errText(e))); return null; }
  }
  const patch = (p, status) => act(() => api('PATCH', `/recurring/${p.id}`, { body: { status } }), t('plan.updated')).then((r) => r && ctx.rerender());

  function card(p) {
    const actions = h('div', { class: 'actions' });
    const draw = () => {
      const kids = [];
      if (p.status === 'active') {
        if (p.awaitingPaymentBookingId) kids.push(h('a', { class: 'btn btn-primary', href: `#/bookings/${p.awaitingPaymentBookingId}` }, t('plan.pay')));
        else if (p.nextAt) kids.push(h('button', { class: 'btn btn-primary', type: 'button', 'data-next': p.id, onclick: async () => { const r = await act(() => api('POST', `/recurring/${p.id}/next`, { body: {} })); if (r) ctx.navigate(`#/bookings/${r.bookingId}?new=1`); } }, t('plan.next')));
        kids.push(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => patch(p, 'paused') }, t('plan.pause')));
      }
      if (p.status === 'paused') kids.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => patch(p, 'active') }, t('plan.resume')));
      if (p.status === 'active' || p.status === 'paused') {
        kids.push(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => {
          actions.replaceChildren(h('span', { class: 'confirm-ask' }, t('plan.cancel.ask')),
            h('button', { class: 'btn btn-danger', type: 'button', onclick: () => patch(p, 'cancelled') }, t('bk.cancel.yes')),
            h('button', { class: 'btn btn-ghost', type: 'button', onclick: draw }, t('bk.cancel.no')));
        } }, t('plan.cancel')));
      }
      actions.replaceChildren(...kids);
    };
    draw();
    const left = p.sessionsTotal ? t('plan.left', { n: p.sessionsRemaining, total: p.sessionsTotal }) : t('plan.ongoing');
    return h('div', { class: 'card', 'data-plan': p.id },
      h('div', { class: 'detail-head' },
        h('div', {}, h('strong', {}, p.service.name), h('div', { class: 'muted' }, `${t(FREQ[p.frequency])} · ${left}`), h('div', { class: 'muted small' }, p.addressLabel)),
        h('span', { class: `badge badge-plan-${p.status}` }, t(`plan.status.${p.status}`))),
      p.nextAt && p.status === 'active' ? h('p', { class: 'small' }, t('plan.nextAt', { date: fmtDay(p.nextAt.slice(0, 10)) })) : null,
      p.keepProvider ? h('p', { class: 'muted small' }, t('plan.keep')) : null,
      actions);
  }
  return h('div', { class: 'container narrow-lg' }, h('h1', {}, t('plan.title')), msg,
    plans.length ? h('div', { class: 'list' }, plans.map(card)) : h('div', { class: 'card empty' }, h('p', {}, t('plan.empty')), h('a', { class: 'btn btn-primary', href: '#/' }, t('bk.cta'))));
}

// ───────────── provider: my reviews ─────────────

export async function providerReviewsPage(ctx) {
  const blocked = guard(ctx, 'provider');
  if (blocked) return blocked;
  const d = await api('GET', '/provider/reviews');
  return h('div', { class: 'container narrow-lg' }, providerNav('reviews'), h('h1', {}, t('prev.title')),
    h('div', { class: 'card' }, d.ratingCount
      ? h('div', {}, h('div', { class: 'big-rating' }, d.ratingAvg.toFixed(1), ' ', h('span', { class: 'stars' }, '★')), h('p', { class: 'muted' }, t('prev.count', { n: d.ratingCount })))
      : h('p', { class: 'muted' }, t('prev.none'))),
    d.reviews.length ? h('div', { class: 'list' }, d.reviews.map((r) => h('div', { class: 'card', 'data-review-item': true },
      h('div', { class: 'detail-head' }, h('div', {}, h('div', { class: 'stars', 'aria-label': `${r.rating}/5` }, stars(r.rating)), h('div', { class: 'muted small' }, `${r.service} · ${r.customer}`)), h('span', { class: 'muted small' }, fmtWhen(r.createdAt))),
      r.comment ? h('p', {}, r.comment) : null))) : null);
}

// ───────────── admin: dispute desk (EN only, like the rest of the admin screens) ─────────────

export async function disputesTab(ctx, message, run) {
  const all = ctx.query.show === 'all';
  const { disputes } = await api('GET', '/admin/disputes', { query: { status: all ? 'all' : 'open' } });

  function card(d) {
    const evidence = h('div');
    const form = h('div');
    const chatBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => {
      chatBtn.disabled = true;
      try {
        const { messages } = await api('GET', `/admin/bookings/${d.bookingId}/messages`);
        chatBtn.replaceWith(h('div', { class: 'chat-list admin-chat' }, messages.length ? messages.map((m) => h('div', { class: `msg ${m.from === 'customer' ? 'theirs' : 'mine'}` }, h('div', { class: 'small muted' }, `${m.from} · ${fmtWhen(m.createdAt)}`), h('div', { class: 'bubble' }, m.body))) : h('p', { class: 'muted small' }, 'No messages.')));
      } catch (e) { message.replaceChildren(banner('error', errText(e))); chatBtn.disabled = false; }
    } }, `Chat (${d.messages})`);
    evidence.append(
      h('div', { class: 'photo-box' }, ['before', 'after'].filter((k) => d.photos[k]).map((k) => h('div', { class: 'photo-slot' }, h('div', { class: 'small' }, k), protectedImg(`/bookings/${d.bookingId}/photos/${k}`, k, ctx.onCleanup, 'thumb thumb-lg')))),
      chatBtn);

    if (d.status === 'open') {
      const outcome = h('select', { 'aria-label': 'Outcome' }, h('option', { value: 'refund' }, 'Refund customer'), h('option', { value: 'redo' }, 'Provider redoes the job'), h('option', { value: 'reject' }, 'Reject complaint (pay provider)'));
      const amount = h('input', { type: 'number', min: '0', step: '0.01', placeholder: `Amount RM (blank = full, max ${(d.refundableCents / 100).toFixed(2)})`, 'aria-label': 'Refund amount' });
      const charge = h('input', { type: 'checkbox', id: `chg-${d.id}` });
      const chargeRow = h('label', { class: 'check', for: `chg-${d.id}` }, charge, ' Take the refund out of the provider\'s payout');
      const refundBits = h('div', {}, amount, chargeRow);
      const note = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Note (shown to the customer)', 'aria-label': 'Note' });
      outcome.addEventListener('change', () => { refundBits.hidden = outcome.value !== 'refund'; });
      const go = h('button', { class: 'btn btn-primary', type: 'button', 'data-resolve': d.id, onclick: () => {
        const body = { outcome: outcome.value, note: note.value.trim() };
        if (outcome.value === 'refund') {
          if (amount.value.trim()) body.amountCents = Math.round(parseFloat(amount.value) * 100);
          if (charge.checked) body.chargeProvider = true;
        }
        run(() => api('POST', `/admin/disputes/${d.id}/resolve`, { body }), 'Dispute settled');
      } }, 'Settle');
      form.append(outcome, refundBits, note, h('div', { class: 'actions' }, go));
    }
    return h('div', { class: 'card', 'data-dispute-card': d.id },
      h('div', { class: 'detail-head' },
        h('div', {}, h('strong', {}, d.service), h('div', {}, `${fmtWhen(d.scheduledAt)} · ${money(d.totalCents)}`), h('div', { class: 'muted small' }, `${d.customer} → ${d.provider ?? '—'}`)),
        h('span', { class: `badge ${d.status === 'open' ? 'badge-disputed' : 'badge-completed'}` }, d.status.replace('_', ' '))),
      h('blockquote', { class: 'reason' }, d.reason),
      h('p', { class: 'muted small' }, `Payment: ${d.paymentStatus ?? '—'} · refundable ${money(d.refundableCents)} · provider payout ${d.payoutCents == null ? '—' : money(d.payoutCents)}`),
      d.resolutionNote ? h('p', {}, `Resolution: ${d.resolutionNote}${d.refundCents ? ` (refund ${money(d.refundCents)})` : ''}`) : null,
      evidence, form);
  }
  return h('div', {},
    h('p', {}, h('a', { href: all ? '#/admin?tab=disputes' : '#/admin?tab=disputes&show=all' }, all ? 'Show open only' : 'Show settled too')),
    disputes.length ? h('div', { class: 'list' }, disputes.map(card)) : h('div', { class: 'card empty' }, h('p', {}, 'No disputes.')));
}
