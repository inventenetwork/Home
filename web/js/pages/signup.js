import { api, getUser, isLoggedIn, startSession } from '../api.js';
import { getLang, t } from '../i18n.js';
import { banner, config, errText, field, h, svg } from '../ui.js';

const ICON = (inner) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const PERKS = [
  [ICON('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>'), 'signup.perk1'],
  [ICON('<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'), 'signup.perk2'],
  [ICON('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'), 'signup.perk3'],
];
const STEPS = ['signup.step1', 'signup.step2', 'signup.step3'];
const safeNext = (raw) => (typeof raw === 'string' && raw.startsWith('#/') && !raw.startsWith('#/login') && !raw.startsWith('#/signup') ? raw : '#/');

/** Customer sign-up. Normal mode: email code sign-up. Demo mode: a short form that creates the account on the spot. */
export function signupPage(ctx) {
  const next = safeNext(ctx.query.next);
  const user = getUser();
  const state = { fullName: '', email: '', phone: '', consent: false };
  let busy = false;
  const errorBox = h('div', { 'aria-live': 'polite' });

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    errorBox.replaceChildren();
    try {
      const resp = await api('POST', '/auth/demo-register', { auth: false, body: { ...state, role: 'customer', locale: getLang() } });
      startSession(resp);
      ctx.navigate(next);
      return;
    } catch (err) {
      errorBox.replaceChildren(banner('error', errText(err)));
    }
    busy = false;
  }

  let action;
  if (isLoggedIn()) {
    action = h('div', { class: 'card join-form' }, h('h2', {}, t('signup.have')), h('a', { class: 'btn btn-primary', href: '#/' }, t('signup.browse')));
  } else if (config.demo) {
    const input = (id, key, label, attrs = {}) =>
      field(id, label, h('input', { id, value: state[key], oninput: (e) => (state[key] = e.target.value), ...attrs }));
    action = h('form', { class: 'card join-form', onsubmit: submit },
      h('h2', {}, t('signup.formTitle')),
      h('p', { class: 'muted small' }, t('join.formSub')),
      input('su-name', 'fullName', t('join.name'), { autocomplete: 'name', required: true, maxlength: 80 }),
      input('su-email', 'email', t('login.email'), { type: 'email', autocomplete: 'email', required: true, maxlength: 254 }),
      input('su-phone', 'phone', t('join.phone'), { type: 'tel', autocomplete: 'tel', placeholder: '012-345 6789', maxlength: 30 }),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', required: true, onchange: (e) => (state.consent = e.target.checked) }),
        h('span', {}, t('login.consent'), ' ', h('a', { href: '#/terms', target: '_blank', rel: 'noopener' }, t('footer.terms')), ' · ', h('a', { href: '#/privacy', target: '_blank', rel: 'noopener' }, t('footer.privacy')))),
      errorBox,
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, t('signup.submit')),
      h('p', { class: 'muted small' }, t('join.signin'), ' ', h('a', { href: `#/login?next=${encodeURIComponent(next)}` }, t('nav.login'))),
    );
  } else {
    action = h('div', { class: 'card join-form' },
      h('h2', {}, t('signup.formTitle')),
      h('p', { class: 'muted' }, t('signup.emailNote')),
      h('a', { class: 'btn btn-primary btn-block', href: `#/login?next=${encodeURIComponent(next)}` }, t('join.start')),
    );
  }
  void user;

  return h('div', { class: 'container' },
    h('section', { class: 'join-hero' },
      h('p', { class: 'eyebrow' }, t('signup.eyebrow')),
      h('h1', {}, t('signup.title.a'), ' ', h('span', { class: 'gold-text' }, t('signup.title.b'))),
      h('p', { class: 'landing-sub' }, t('signup.sub')),
    ),
    h('div', { class: 'join-layout' },
      h('div', { class: 'join-info' },
        h('ul', { class: 'perks' }, PERKS.map(([icon, key]) => h('li', { class: 'perk' }, svg(icon, 'trust-icon'), h('div', {}, h('strong', {}, t(`${key}.t`)), h('p', { class: 'muted' }, t(`${key}.d`)))))),
        h('h2', { class: 'block-title' }, t('signup.how')),
        h('ol', { class: 'join-steps' }, STEPS.map((k, i) => h('li', {}, h('span', { class: 'step-num' }, String(i + 1)), h('div', {}, h('strong', {}, t(`${k}.t`)), h('p', { class: 'muted' }, t(`${k}.d`)))))),
      ),
      action,
    ),
  );
}
