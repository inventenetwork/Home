import { api } from '../api.js';
import { fmtDay, t } from '../i18n.js';
import { protectedImg } from '../photos.js';
import { banner, errText, field, fileButton, h, imageToDataUrl, money, mytDate, toast } from '../ui.js';
import { guard, notApprovedPanel, providerNav } from './provider.js';

const BANKS = ['Maybank', 'CIMB Bank', 'Public Bank', 'RHB Bank', 'Hong Leong Bank', 'AmBank', 'Bank Islam', 'Bank Rakyat', 'BSN', 'Affin Bank', 'Alliance Bank', 'OCBC Bank', 'UOB', 'HSBC', 'Standard Chartered', 'Agrobank', 'MBSB Bank'];
const REQUIRED_DOCS = ['id_front', 'id_back', 'selfie'];

// ───────────── profile / application ─────────────

export async function providerProfilePage(ctx) {
  const blocked = guard(ctx, 'provider');
  if (blocked) return blocked;
  const [meInit, options] = await Promise.all([api('GET', '/provider/me'), api('GET', '/provider/options')]);
  let me = meInit;
  const approvedSkills = [...me.profile.skillCodes]; // an approved provider may untick these, never add others
  const form = { ...me.profile, areaSlugs: [...me.profile.areaSlugs], skillCodes: [...me.profile.skillCodes] };
  const bankForm = { bankName: '', accountName: me.profile.fullName ?? '', accountNumber: '' };
  let editBank = !me.bank;
  let busy = false;
  const message = h('div');
  const root = h('div');

  const approved = () => me.status === 'approved';
  const suspended = () => me.status === 'suspended';
  const locked = () => suspended();

  async function call(method, path, body, okText) {
    if (busy) return;
    busy = true;
    message.replaceChildren();
    draw();
    try {
      me = await api(method, path, body === undefined ? {} : { body });
      if (okText) toast(okText, 'success');
      return true;
    } catch (err) {
      message.replaceChildren(banner('error', errText(err)));
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return false;
    } finally {
      busy = false;
      draw();
    }
  }

  const toggle = (list, value, on) => {
    const i = list.indexOf(value);
    if (on && i === -1) list.push(value);
    if (!on && i !== -1) list.splice(i, 1);
  };

  function statusBanner() {
    if (me.status === 'approved') return banner('success', t('pf.status.approved'));
    if (me.status === 'suspended') return banner('error', t('pf.status.suspended'));
    if (me.status === 'rejected') return banner('error', t('pf.status.rejected', { reason: me.rejectionReason ?? '' }));
    return banner('info', me.submittedAt ? t('pf.status.review') : t('pf.status.draft'));
  }

  function aboutSection() {
    const check = (name, value, label, list, disabled) =>
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', name, value, checked: list.includes(value), disabled: disabled || locked(), onchange: (e) => toggle(list, value, e.target.checked) }),
        h('span', {}, label));
    return h('section', { class: 'card step-card' },
      h('h2', {}, t('pf.about')),
      field('pf-name', t('pf.name'), h('input', { id: 'pf-name', type: 'text', autocomplete: 'name', maxlength: 100, value: form.fullName ?? '', disabled: locked(), oninput: (e) => (form.fullName = e.target.value) })),
      field('pf-phone', t('pf.phone'), h('input', { id: 'pf-phone', type: 'text', inputmode: 'tel', autocomplete: 'tel', maxlength: 30, value: form.phone ?? '', disabled: locked(), oninput: (e) => (form.phone = e.target.value) }), t('pf.phone.hint')),
      field('pf-bio', t('pf.bio'), h('textarea', { id: 'pf-bio', rows: 3, maxlength: 500, disabled: locked(), oninput: (e) => (form.bio = e.target.value) }, form.bio ?? '')),
      h('fieldset', { class: 'group' }, h('legend', {}, t('pf.areas')),
        h('div', { class: 'check-grid' }, options.areas.map((a) => check('area', a.slug, a.name, form.areaSlugs, false)))),
      h('fieldset', { class: 'group' }, h('legend', {}, t('pf.skills')),
        h('div', { class: 'check-grid' }, options.skills.map((s) => check('skill', s.code, s.name, form.skillCodes, approved() && !approvedSkills.includes(s.code)))),
        approved() ? h('p', { class: 'hint' }, t('pf.skills.locked')) : null),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', 'data-save-profile': true, disabled: busy || locked(), onclick: () =>
          call('PUT', '/provider/profile', { fullName: (form.fullName ?? '').trim(), phone: (form.phone ?? '').trim(), bio: (form.bio ?? '').trim(), areaSlugs: form.areaSlugs, skillCodes: form.skillCodes }, t('pf.saved')) }, t('pf.save'))),
    );
  }

  function bankSection() {
    const inputs = [
      field('pf-bank', t('pf.bank.name'), h('input', { id: 'pf-bank', type: 'text', list: 'bank-list', maxlength: 60, value: bankForm.bankName, oninput: (e) => (bankForm.bankName = e.target.value) })),
      h('datalist', { id: 'bank-list' }, BANKS.map((b) => h('option', { value: b }))),
      field('pf-holder', t('pf.bank.holder'), h('input', { id: 'pf-holder', type: 'text', maxlength: 100, value: bankForm.accountName, oninput: (e) => (bankForm.accountName = e.target.value) })),
      field('pf-acct', t('pf.bank.number'), h('input', { id: 'pf-acct', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 25, value: bankForm.accountNumber, oninput: (e) => (bankForm.accountNumber = e.target.value) }), t('pf.bank.number.hint')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', 'data-save-bank': true, disabled: busy || locked(), onclick: async () => {
          const ok = await call('PUT', '/provider/bank', { bankName: bankForm.bankName.trim(), accountName: bankForm.accountName.trim(), accountNumber: bankForm.accountNumber.trim() }, t('pf.saved'));
          if (ok) { editBank = false; bankForm.accountNumber = ''; draw(); }
        } }, t('pf.bank.save')),
        me.bank ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { editBank = false; draw(); } }, t('common.back')) : null),
    ];
    return h('section', { class: 'card step-card' },
      h('h2', {}, t('pf.bank')),
      editBank || !me.bank
        ? inputs
        : [h('p', { 'data-bank-current': true }, t('pf.bank.current', { bank: me.bank.bankName, last4: me.bank.last4 })),
           h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: locked(), onclick: () => { editBank = true; bankForm.bankName = me.bank.bankName; bankForm.accountName = me.bank.accountName; draw(); } }, t('pf.bank.change')))],
    );
  }

  async function upload(docType, file) {
    if (busy) return;
    message.replaceChildren();
    let image;
    try {
      image = await imageToDataUrl(file);
    } catch (err) {
      message.replaceChildren(banner('error', errText(err)));
      return;
    }
    await call('POST', '/provider/documents', { docType, image }, t('pf.doc.toast'));
  }

  function docRow(docType, doc) {
    const status = !doc ? t('pf.doc.missing') : doc.reviewStatus === 'approved' ? t('pf.doc.approved') : doc.reviewStatus === 'rejected' ? t('pf.doc.rejected', { note: doc.reviewNote ?? '' }) : t('pf.doc.uploaded');
    const frozen = approved() && docType !== 'certificate';
    return h('div', { class: 'doc-row', 'data-doc': docType },
      doc ? protectedImg(`/provider/documents/${doc.id}/file`, t(`pf.doc.${docType}`), ctx.onCleanup) : h('div', { class: 'thumb thumb-empty', 'aria-hidden': 'true' }),
      h('div', { class: 'doc-info' },
        h('strong', {}, t(`pf.doc.${docType}`)),
        h('div', { class: `small ${doc?.reviewStatus === 'rejected' ? 'text-danger' : 'muted'}` }, status)),
      h('div', { class: 'doc-actions' },
        frozen ? null : fileButton({ label: doc && docType !== 'certificate' ? t('pf.doc.replace') : t('pf.doc.upload'), capture: docType === 'selfie' ? 'user' : 'environment', disabled: busy || locked(), name: docType, onFile: (f) => upload(docType, f) }),
        doc && docType === 'certificate' ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: busy, onclick: () => call('DELETE', `/provider/documents/${doc.id}`) }, t('pf.doc.remove')) : null),
    );
  }

  function docsSection() {
    const certs = me.documents.filter((d) => d.docType === 'certificate');
    return h('section', { class: 'card step-card' },
      h('h2', {}, t('pf.docs')),
      h('p', { class: 'muted small' }, t('pf.docs.sub')),
      REQUIRED_DOCS.map((d) => docRow(d, me.documents.find((x) => x.docType === d))),
      certs.map((c) => docRow('certificate', c)),
      certs.length < 5 ? h('div', { class: 'doc-row' }, h('div', { class: 'doc-info' }, h('strong', {}, t('pf.doc.certificate.add'))),
        h('div', { class: 'doc-actions' }, fileButton({ label: t('pf.doc.upload'), capture: 'environment', disabled: busy || locked(), name: 'certificate', onFile: (f) => upload('certificate', f) }))) : null,
    );
  }

  function submitSection() {
    if (approved() || suspended()) return null;
    if (me.status === 'pending' && me.submittedAt) return null;
    const need = me.missing.map((m) => t(`pf.need.${m}`));
    return h('section', { class: 'card step-card' },
      need.length ? h('p', { 'data-missing': true }, t('pf.missing', { list: need.join(', ') })) : h('p', {}, t('pf.ready')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', 'data-submit': true, disabled: busy || !me.canSubmit, onclick: () => call('POST', '/provider/submit', {}, t('pf.submitted')) }, t('pf.submit'))),
    );
  }

  function draw() {
    root.replaceChildren(...[statusBanner(), aboutSection(), bankSection(), docsSection(), submitSection()].filter(Boolean));
  }
  draw();

  return h('div', { class: 'container narrow-lg' }, providerNav('profile'), h('h1', {}, t('pf.title')), message, root);
}

// ───────────── calendar ─────────────

const WEEK = [1, 2, 3, 4, 5, 6, 0];
/** Malaysia calendar date (YYYY-MM-DD) of a UTC timestamp. */
const myDay = (iso) => new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 10);

export async function providerCalendarPage(ctx) {
  const blocked = guard(ctx, 'provider');
  if (blocked) return blocked;
  let cal;
  try {
    cal = await api('GET', '/provider/availability');
  } catch (err) {
    if (err.code === 'provider_not_approved') return notApprovedPanel();
    throw err;
  }
  let windows = cal.windows.map((w) => ({ ...w }));
  let timeOff = cal.timeOff;
  let dayOffDate = mytDate(1);
  let busy = false;
  const message = h('div');
  const hours = h('div');
  const offBox = h('div');

  function drawHours() {
    hours.replaceChildren(
      ...WEEK.map((wd) => {
        const mine = windows.map((w, i) => [w, i]).filter(([w]) => w.weekday === wd);
        return h('div', { class: 'week-row', 'data-weekday': wd },
          h('div', { class: 'week-day' }, t(`day.${wd}`)),
          h('div', { class: 'week-windows' },
            mine.length
              ? mine.map(([w, i]) =>
                  h('div', { class: 'win' },
                    h('input', { type: 'time', 'aria-label': `${t(`day.${wd}`)} ${t('cal.from')}`, value: w.start, step: 900, onchange: (e) => (w.start = e.target.value) }),
                    h('span', { 'aria-hidden': 'true' }, '–'),
                    h('input', { type: 'time', 'aria-label': `${t(`day.${wd}`)} ${t('cal.to')}`, value: w.end, step: 900, onchange: (e) => (w.end = e.target.value) }),
                    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': t('cal.remove'), onclick: () => { windows.splice(i, 1); drawHours(); } }, '✕')))
              : h('span', { class: 'muted small' }, t('cal.off'))),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-add-hours': wd, onclick: () => { windows.push({ weekday: wd, start: '09:00', end: '17:00' }); drawHours(); } }, t('cal.add')));
      }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', 'data-save-hours': true, disabled: busy, onclick: saveHours }, t('cal.save'))),
    );
  }

  async function saveHours() {
    busy = true;
    message.replaceChildren();
    drawHours();
    try {
      const r = await api('PUT', '/provider/availability', { body: { windows } });
      windows = r.windows.map((w) => ({ ...w }));
      toast(t('cal.saved'), 'success');
    } catch (err) {
      message.replaceChildren(banner('error', errText(err)));
    }
    busy = false;
    drawHours();
  }

  function drawOff(warn) {
    offBox.replaceChildren(...[
      warn > 0 ? banner('info', t('cal.timeoff.warn', { n: warn })) : null,
      h('div', { class: 'actions' },
        h('input', { type: 'date', 'aria-label': t('cal.timeoff'), min: mytDate(0), value: dayOffDate, onchange: (e) => (dayOffDate = e.target.value) }),
        h('button', { class: 'btn btn-primary', type: 'button', 'data-add-off': true, onclick: addOff }, t('cal.timeoff.add'))),
      timeOff.length
        ? h('ul', { class: 'plain-list' }, timeOff.map((o) =>
            h('li', { 'data-off': o.date }, h('span', {}, fmtDay(o.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })),
              h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => removeOff(o.id) }, t('cal.remove')))))
        : h('p', { class: 'muted' }, t('cal.timeoff.none')),
    ].filter(Boolean));
  }

  async function addOff() {
    message.replaceChildren();
    try {
      const r = await api('POST', '/provider/time-off', { body: { date: dayOffDate } });
      timeOff = r.timeOff;
      toast(t('cal.timeoff.added'), 'success');
      drawOff(r.bookedJobsThatDay);
    } catch (err) {
      message.replaceChildren(banner('error', errText(err)));
    }
  }

  async function removeOff(id) {
    message.replaceChildren();
    try {
      timeOff = (await api('DELETE', `/provider/time-off/${id}`)).timeOff;
      drawOff(0);
    } catch (err) {
      message.replaceChildren(banner('error', errText(err)));
    }
  }

  drawHours();
  drawOff(0);
  return h('div', { class: 'container narrow-lg' },
    providerNav('calendar'),
    h('h1', {}, t('cal.title')),
    message,
    h('section', { class: 'card step-card' }, h('h2', {}, t('cal.hours')), h('p', { class: 'muted small' }, t('cal.hours.sub')), hours),
    h('section', { class: 'card step-card' }, h('h2', {}, t('cal.timeoff')), h('p', { class: 'muted small' }, t('cal.timeoff.sub')), offBox),
  );
}

// ───────────── earnings ─────────────

export async function providerEarningsPage(ctx) {
  const blocked = guard(ctx, 'provider');
  if (blocked) return blocked;
  let e;
  let me;
  try {
    [e, me] = await Promise.all([api('GET', '/provider/earnings'), api('GET', '/provider/me')]);
  } catch (err) {
    if (err.code === 'provider_not_approved') return notApprovedPanel();
    throw err;
  }
  const message = h('div');
  let busy = false;

  async function withdraw(button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    message.replaceChildren();
    try {
      await api('POST', '/provider/payouts/request', { body: {} });
      toast(t('earn.requested.toast'), 'success');
      ctx.rerender();
    } catch (err) {
      busy = false;
      button.disabled = false;
      message.replaceChildren(banner('error', errText(err), err.code === 'no_bank_details' ? [' ', h('a', { href: '#/provider/profile' }, t('pnav.profile'))] : null));
    }
  }

  const stat = (key, cents, cls = '') => h('div', { class: `stat ${cls}`, 'data-stat': key }, h('div', { class: 'stat-label' }, t(`earn.${key}`)), h('div', { class: 'stat-value' }, money(cents)));
  const statusBadge = (s) => h('span', { class: `badge badge-pay-${s}` }, t(`earn.status.${s}`));

  return h('div', { class: 'container narrow-lg' },
    providerNav('earnings'),
    h('h1', {}, t('earn.title')),
    message,
    !me.bank ? banner('info', t('earn.bank.missing'), ' ', h('a', { href: '#/provider/profile' }, t('pnav.profile'))) : null,
    h('div', { class: 'stat-grid' }, stat('available', e.availableCents, 'stat-main'), stat('waiting', e.waitingCents), stat('requested', e.requestedCents), stat('paid', e.paidCents)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'button', 'data-withdraw': true, disabled: e.availableCents <= 0, onclick: (ev) => withdraw(ev.currentTarget) }, t('earn.withdraw', { amount: money(e.availableCents) })),
      h('span', { class: 'muted small' }, t('earn.min', { amount: money(e.minPayoutCents) }))),
    h('p', { class: 'muted small' }, t('earn.hold')),
    h('h2', { class: 'section-gap' }, t('earn.history')),
    e.items.length
      ? h('div', { class: 'list' }, e.items.map((i) =>
          h('div', { class: 'card booking-card', 'data-earning': i.bookingId },
            h('div', {},
              h('strong', {}, i.service ?? '—'),
              h('div', { class: 'muted small' }, fmtDay(myDay(i.completedAt), { day: 'numeric', month: 'short', year: 'numeric' })),
              i.status === 'waiting' && i.availableAt ? h('div', { class: 'muted small' }, t('earn.availableOn', { date: fmtDay(myDay(i.availableAt), { day: 'numeric', month: 'short' }) })) : null),
            h('div', { class: 'right' }, statusBadge(i.status), h('div', { class: 'amt' }, money(i.netCents))))))
      : h('div', { class: 'card empty' }, h('p', {}, t('earn.empty'))),
  );
}
