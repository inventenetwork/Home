import { api, getUser, isLoggedIn } from '../api.js';
import { fmtDay, fmtDuration, t } from '../i18n.js';
import { protectedImg } from '../photos.js';
import { chatPanel, loadUnread } from './extras.js';
import { banner, errText, fileButton, fmtCountdown, h, imageToDataUrl, money, statusBadge, toast } from '../ui.js';

/** Returns a replacement page when the visitor should not see this one, otherwise null. */
export function guard(ctx, role) {
  if (!isLoggedIn()) {
    ctx.navigate(`#/login?next=${encodeURIComponent(location.hash)}`);
    return h('div');
  }
  if (getUser()?.role !== role) {
    return h('div', { class: 'container narrow' }, banner('info', t(role === 'provider' ? 'prov.only' : 'adm.only')));
  }
  return null;
}

/** Tabs shown at the top of every provider page. */
export function providerNav(active) {
  const tab = (key, href) => h('a', { class: `tab${active === key ? ' on' : ''}`, href, 'aria-current': active === key ? 'page' : null }, t(`pnav.${key}`));
  return h('div', { class: 'tabs', role: 'navigation', 'aria-label': 'Provider' },
    tab('offers', '#/provider'), tab('jobs', '#/provider/jobs'), tab('calendar', '#/provider/calendar'), tab('earnings', '#/provider/earnings'), tab('reviews', '#/provider/reviews'), tab('profile', '#/provider/profile'));
}

/** What a provider sees on pages that need approval before their application is approved. */
export function notApprovedPanel() {
  return h('div', { class: 'container narrow-lg' },
    providerNav(''),
    h('div', { class: 'card empty', 'data-not-approved': true },
      h('p', {}, t('prov.notApproved')),
      h('a', { class: 'btn btn-primary', href: '#/provider/profile' }, t('prov.notApproved.cta'))));
}

const whenText = (o) => `${fmtDay(o.localDate, { weekday: 'short', day: 'numeric', month: 'short' })}, ${o.localTime} · ${fmtDuration(o.durationMinutes)}`;

// ───────────── job offers ─────────────

export async function providerOffersPage(ctx) {
  const blocked = guard(ctx, 'provider');
  if (blocked) return blocked;

  let offers = [];
  let deadlines = new Map(); // bookingId -> epoch ms, from the server's secondsLeft (so a wrong phone clock does not matter)
  let confirming = null; // bookingId whose "decline?" question is open
  let busy = null;
  const message = h('div');
  const list = h('div', { class: 'list' });

  async function load() {
    const r = await api('GET', '/provider/offers');
    const before = offers.map((o) => o.bookingId).join();
    offers = r.offers;
    const now = Date.now();
    deadlines = new Map(offers.map((o) => [o.bookingId, now + o.secondsLeft * 1000]));
    return before !== offers.map((o) => o.bookingId).join();
  }

  const left = (id) => Math.max(0, Math.round((deadlines.get(id) - Date.now()) / 1000));

  async function act(o, kind) {
    busy = o.bookingId;
    message.replaceChildren();
    draw();
    try {
      await api('POST', `/provider/offers/${o.bookingId}/${kind}`, { body: {} });
      if (kind === 'accept') {
        toast(t('off.accepted'), 'success');
        ctx.navigate('#/provider/jobs');
        return;
      }
      toast(t('off.declined'));
    } catch (err) {
      message.replaceChildren(banner('error', errText(err)));
    }
    busy = null;
    confirming = null;
    try { await load(); } catch { /* keep what we have */ }
    draw();
  }

  function card(o) {
    const expired = left(o.bookingId) === 0;
    const buttons =
      confirming === o.bookingId
        ? [
            h('span', { class: 'confirm-ask' }, t('off.decline.ask')),
            h('button', { class: 'btn btn-danger', type: 'button', disabled: busy !== null, onclick: () => act(o, 'decline') }, t('off.decline.yes')),
            h('button', { class: 'btn btn-ghost', type: 'button', disabled: busy !== null, onclick: () => { confirming = null; draw(); } }, t('common.back')),
          ]
        : [
            h('button', { class: 'btn btn-primary', type: 'button', 'data-accept': o.bookingId, disabled: busy !== null || expired, onclick: () => act(o, 'accept') }, t('off.accept')),
            h('button', { class: 'btn btn-ghost', type: 'button', 'data-decline': o.bookingId, disabled: busy !== null || expired, onclick: () => { confirming = o.bookingId; draw(); } }, t('off.decline')),
          ];
    return h('div', { class: 'card offer-card', 'data-offer': o.bookingId },
      h('div', { class: 'detail-head' },
        h('div', {},
          h('strong', {}, o.service),
          h('div', {}, whenText(o)),
          h('div', { class: 'muted small' }, o.area ?? ''),
        ),
        h('div', { class: 'right' },
          h('div', { class: 'amt' }, t('off.earn', { amount: money(o.earningsCents) })),
          h('div', { class: 'countdown', 'data-countdown': o.bookingId }, expired ? t('off.expired') : t('off.left', { time: fmtCountdown(left(o.bookingId)) })),
        ),
      ),
      h('div', { class: 'actions' }, ...buttons),
    );
  }

  function draw() {
    list.replaceChildren(...(offers.length ? offers.map(card) : [h('div', { class: 'card empty' }, h('p', {}, t('off.empty')))]));
  }

  try {
    await load();
  } catch (err) {
    if (err.code === 'provider_not_approved') return notApprovedPanel();
    throw err;
  }
  draw();

  // Count down every second; look for new offers every 15 seconds.
  const tick = setInterval(() => {
    for (const o of offers) {
      const el = list.querySelector(`[data-countdown="${o.bookingId}"]`);
      if (!el) continue;
      const s = left(o.bookingId);
      if (s === 0 && !el.dataset.done) {
        el.dataset.done = '1';
        load().then(draw, () => {});
      } else if (s > 0) {
        el.textContent = t('off.left', { time: fmtCountdown(s) });
      }
    }
  }, 1000);
  const poll = setInterval(() => {
    if (busy === null && confirming === null) load().then((changed) => changed && draw(), () => {});
  }, 15_000);
  ctx.onCleanup(() => { clearInterval(tick); clearInterval(poll); });

  return h('div', { class: 'container narrow-lg' }, providerNav('offers'), h('h1', {}, t('off.title')), h('p', { class: 'muted' }, t('off.sub')), message, list);
}

// ───────────── my jobs ─────────────

const NEXT = {
  confirmed: ['on_the_way', 'jobs.otw'],
  on_the_way: ['in_progress', 'jobs.start'],
  in_progress: ['completed', 'jobs.finish'],
};

export async function providerJobsPage(ctx) {
  const blocked = guard(ctx, 'provider');
  if (blocked) return blocked;
  let data;
  try {
    data = await api('GET', '/provider/jobs', { query: { status: 'all' } });
  } catch (err) {
    if (err.code === 'provider_not_approved') return notApprovedPanel();
    throw err;
  }
  const { jobs, requireAfterPhoto } = data;
  const unread = await loadUnread();
  const upcoming = jobs.filter((j) => j.status in NEXT);
  const past = jobs.filter((j) => !(j.status in NEXT)).reverse();
  const message = h('div');

  async function advance(job, status, button) {
    button.disabled = true;
    message.replaceChildren();
    try {
      await api('POST', `/provider/jobs/${job.id}/status`, { body: { status } });
      toast(t('jobs.updated'), 'success');
      ctx.rerender();
    } catch (err) {
      button.disabled = false;
      message.replaceChildren(banner('error', errText(err)));
    }
  }

  async function addPhoto(job, kind, file) {
    message.replaceChildren();
    try {
      const image = await imageToDataUrl(file);
      await api('POST', `/provider/jobs/${job.id}/photos`, { body: { kind, image } });
      toast(t('jobs.photo.saved'), 'success');
      ctx.rerender();
    } catch (err) {
      message.replaceChildren(banner('error', errText(err)));
    }
  }

  const row = (label, value) => h('div', { class: 'row' }, h('dt', {}, label), h('dd', {}, value));

  /** Before/after photo controls: "before" from the moment the provider is on the way, "after" while working. */
  function photoBox(j) {
    const canBefore = j.status === 'on_the_way' || j.status === 'in_progress';
    const canAfter = j.status === 'in_progress';
    const slot = (kind, can) => {
      const have = j.photos[kind];
      return h('div', { class: 'photo-slot', 'data-photo-slot': kind },
        h('div', { class: 'small' }, t(`jobs.photo.${kind}`)),
        have ? protectedImg(`/bookings/${j.id}/photos/${kind}`, t(`jobs.photo.${kind}`), ctx.onCleanup) : h('div', { class: 'thumb thumb-empty', 'aria-hidden': 'true' }),
        can ? fileButton({ label: have ? t('jobs.photo.retake') : t('jobs.photo.add'), capture: 'environment', name: kind, onFile: (f) => addPhoto(j, kind, f) }) : null);
    };
    if (!canBefore && !j.photos.before && !j.photos.after) return null;
    return h('div', { class: 'photo-box' }, slot('before', canBefore), slot('after', canAfter));
  }

  const card = (j) => {
    const next = NEXT[j.status];
    const needsAfter = next && next[0] === 'completed' && requireAfterPhoto && !j.photos.after;
    const btn = next ? h('button', { class: 'btn btn-primary', type: 'button', 'data-next': j.id, disabled: needsAfter, onclick: (e) => advance(j, next[0], e.currentTarget) }, t(next[1])) : null;
    return h('div', { class: 'card', 'data-job': j.id },
      h('div', { class: 'detail-head' },
        h('div', {}, h('strong', {}, j.service), h('div', {}, whenText(j))),
        statusBadge(j.status),
      ),
      h('dl', { class: 'facts' },
        row(t('bk.where'), [j.address.line1, j.address.line2, `${j.address.postcode}${j.address.area ? ` ${j.address.area}` : ''}`].filter(Boolean).join(', ')),
        j.customerFirstName ? row(t('jobs.customer'), j.customerFirstName) : null,
        j.notes ? row(t('jobs.notes'), j.notes) : null,
        row(t('bk.price'), t('off.earn', { amount: money(j.earningsCents) })),
      ),
      photoBox(j),
      needsAfter ? h('p', { class: 'hint', 'data-need-after': true }, t('jobs.photo.needAfter')) : null,
      btn ? h('div', { class: 'actions' }, btn) : null,
      ['confirmed', 'on_the_way', 'in_progress', 'completed', 'disputed'].includes(j.status) ? chatPanel(ctx, j.id, unread[j.id] ?? 0) : null,
    );
  };

  return h('div', { class: 'container narrow-lg' },
    providerNav('jobs'),
    h('h1', {}, t('jobs.title')),
    message,
    h('h2', {}, t('jobs.upcoming')),
    upcoming.length ? h('div', { class: 'list' }, upcoming.map(card)) : h('div', { class: 'card empty' }, h('p', {}, t('jobs.empty'))),
    past.length ? [h('h2', { class: 'section-gap' }, t('jobs.past')), h('div', { class: 'list' }, past.map(card))] : null,
  );
}
