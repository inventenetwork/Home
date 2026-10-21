import { api, getUser, isLoggedIn, startSession } from '../api.js';
import { getLang, t } from '../i18n.js';
import { banner, config, errText, field, h, svg } from '../ui.js';

const ICON = (inner) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const PERKS = [
  [ICON('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/>'), 'join.perk1'],
  [ICON('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'), 'join.perk2'],
  [ICON('<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'), 'join.perk3'],
];
const STEPS = ['join.step1', 'join.step2', 'join.step3'];

/** Vendor registration. Normal mode: email code sign-up. Demo mode: a short form that creates the account on the spot. */
export function joinPage(ctx) {
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
      const resp = await api('POST', '/auth/demo-register', { auth: false, body: { ...state, locale: getLang() } });
      startSession(resp);
      ctx.navigate('#/provider/profile');
      return;
    } catch (err) {
      errorBox.replaceChildren(banner('error', errText(err)));
    }
    busy = false;
  }

  let action;
  if (isLoggedIn() && user?.role === 'provider') {
    action = h('div', { class: 'card join-form' }, h('h2', {}, t('join.have')), h('a', { class: 'btn btn-primary', href: '#/provider/profile' }, t('join.continue')));
  } else if (isLoggedIn()) {
    action = h('div', { class: 'card join-form' }, banner('info', t('join.customerNote')));
  } else if (config.demo) {
    const input = (id, key, label, attrs = {}) =>
      field(id, label, h('input', { id, value: state[key], oninput: (e) => (state[key] = e.target.value), ...attrs }));
    action = h('form', { class: 'card join-form', onsubmit: submit },
      h('h2', {}, t('join.formTitle')),
      h('p', { class: 'muted small' }, t('join.formSub')),
      input('join-name', 'fullName', t('join.name'), { autocomplete: 'name', required: true, maxlength: 80 }),
      input('join-email', 'email', t('login.email'), { type: 'email', autocomplete: 'email', required: true, maxlength: 254 }),
      input('join-phone', 'phone', t('join.phone'), { type: 'tel', autocomplete: 'tel', placeholder: '012-345 6789', maxlength: 30 }),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', required: true, onchange: (e) => (state.consent = e.target.checked) }),
        h('span', {}, t('login.consent'), ' ', h('a', { href: '#/terms', target: '_blank', rel: 'noopener' }, t('footer.terms')), ' · ', h('a', { href: '#/privacy', target: '_blank', rel: 'noopener' }, t('footer.privacy')))),
      errorBox,
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, t('join.submit')),
      h('p', { class: 'muted small' }, t('join.signin'), ' ', h('a', { href: '#/login' }, t('nav.login'))),
    );
  } else {
    action = h('div', { class: 'card join-form' },
      h('h2', {}, t('join.formTitle')),
      h('p', { class: 'muted' }, t('join.emailNote')),
      h('a', { class: 'btn btn-primary btn-block', href: '#/login?as=provider' }, t('join.start')),
    );
  }

  return h('div', { class: 'container' },
    h('section', { class: 'join-hero' },
      h('p', { class: 'eyebrow' }, t('join.eyebrow')),
      h('h1', {}, t('join.title.a'), ' ', h('span', { class: 'gold-text' }, t('join.title.b'))),
      h('p', { class: 'landing-sub' }, t('join.sub')),
    ),
    h('div', { class: 'join-layout' },
      h('div', { class: 'join-info' },
        h('ul', { class: 'perks' }, PERKS.map(([icon, key]) => h('li', { class: 'perk' }, svg(icon, 'trust-icon'), h('div', {}, h('strong', {}, t(`${key}.t`)), h('p', { class: 'muted' }, t(`${key}.d`)))))),
        h('h2', { class: 'block-title' }, t('join.how')),
        h('ol', { class: 'join-steps' }, STEPS.map((k, i) => h('li', {}, h('span', { class: 'step-num' }, String(i + 1)), h('div', {}, h('strong', {}, t(`${k}.t`)), h('p', { class: 'muted' }, t(`${k}.d`)))))),
      ),
      action,
    ),
  );
}
