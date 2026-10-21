import { api, getUser, isLoggedIn, startSession } from '../api.js';
import { getLang, t } from '../i18n.js';
import { banner, config, errText, field, h } from '../ui.js';

let gsiPromise = null;
function loadGoogleScript() {
  gsiPromise ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gsiPromise = null;
      reject(new Error('Google script failed to load'));
    };
    document.head.append(s);
  });
  return gsiPromise;
}

// Google's library is initialised once per page load; it calls whichever handler the current login page registered.
let googleHandler = null;
let googleReady = false;

const safeNext = (raw) => (typeof raw === 'string' && raw.startsWith('#/') && !raw.startsWith('#/login') ? raw : '#/');

export function loginPage(ctx) {
  const next = safeNext(ctx.query.next);
  const asProvider = ctx.query.as === 'provider'; // "Join as a provider": new accounts are created as providers
  const roleField = asProvider ? { role: 'provider' } : {};
  if (isLoggedIn()) {
    ctx.navigate(next === '#/' && getUser()?.role === 'provider' ? '#/provider' : next);
    return h('div');
  }

  let step = 'email'; // 'email' | 'code'
  let email = '';
  let code = '';
  let consent = false;
  let busy = false;
  let error = '';
  let pendingGoogle = null; // a Google credential waiting for the consent tick
  let cooldown = 0;
  let timer = null;
  ctx.onCleanup(() => clearInterval(timer));
  googleHandler = null;
  ctx.onCleanup(() => { googleHandler = null; });

  const errorBox = h('div', { class: 'slot-error' });
  const formArea = h('div');
  const googleBlock = h('div', { class: 'google-block', hidden: true });
  const googleBtn = h('div', { class: 'google-btn' });
  googleBlock.append(googleBtn, h('div', { class: 'divider' }, h('span', {}, t('login.or'))));

  function setError(msg) {
    error = msg;
    errorBox.replaceChildren(msg ? banner('error', msg) : '');
  }

  function finish(resp) {
    startSession(resp);
    ctx.navigate(next === '#/' && resp.user.role === 'provider' ? (asProvider ? '#/provider/profile' : '#/provider') : next);
  }

  async function googleLogin(credential) {
    busy = true;
    setError('');
    errorBox.replaceChildren(banner('info', t('login.google')));
    try {
      finish(await api('POST', '/auth/google', { auth: false, body: { idToken: credential, consent, locale: getLang(), ...roleField } }));
    } catch (e) {
      busy = false;
      if (e.code === 'consent_required') pendingGoogle = credential;
      setError(errText(e));
    }
  }
  googleHandler = (resp) => googleLogin(resp.credential);

  function startCooldown(seconds = 60) {
    cooldown = seconds;
    clearInterval(timer);
    timer = setInterval(() => {
      cooldown -= 1;
      if (cooldown <= 0) clearInterval(timer);
      const btn = formArea.querySelector('[data-resend]');
      if (btn) {
        btn.disabled = cooldown > 0;
        btn.textContent = cooldown > 0 ? t('login.resendIn', { s: cooldown }) : t('login.resend');
      }
    }, 1000);
  }

  async function requestCode(e) {
    e?.preventDefault();
    if (busy) return;
    email = email.trim();
    busy = true;
    setError('');
    draw();
    try {
      await api('POST', '/auth/otp/request', { auth: false, body: { email } });
      step = 'code';
      code = '';
      startCooldown();
    } catch (err) {
      setError(errText(err));
    }
    busy = false;
    draw(true);
  }

  async function verify(e) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    setError('');
    draw();
    try {
      finish(await api('POST', '/auth/otp/verify', { auth: false, body: { email, code, consent, locale: getLang(), ...roleField } }));
      return;
    } catch (err) {
      setError(errText(err));
    }
    busy = false;
    draw(true);
  }

  const consentBox = () =>
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        id: 'consent',
        checked: consent,
        onchange: (e) => {
          consent = e.target.checked;
          if (consent && pendingGoogle) {
            const c = pendingGoogle;
            pendingGoogle = null;
            googleLogin(c);
          }
        },
      }),
      h('span', {}, t('login.consent'), ' ', h('a', { href: '#/terms', target: '_blank', rel: 'noopener' }, t('footer.terms')), ' · ', h('a', { href: '#/privacy', target: '_blank', rel: 'noopener' }, t('footer.privacy'))),
    );

  function draw(focus = false) {
    googleBlock.hidden = step !== 'email' || !googleReady;
    if (step === 'email') {
      const input = h('input', {
        id: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', required: true, maxlength: 254,
        value: email, oninput: (e) => (email = e.target.value),
      });
      formArea.replaceChildren(
        h('form', { onsubmit: requestCode, novalidate: false },
          field('email', t('login.email'), input),
          consentBox(),
          h('button', { class: 'btn btn-primary btn-block', type: 'submit', disabled: busy }, busy ? t('login.sending') : t('login.send')),
        ),
      );
      if (focus) input.focus();
    } else {
      const input = h('input', {
        id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6, required: true,
        class: 'code-input', value: code,
        oninput: (e) => {
          code = e.target.value.replace(/\D/g, '').slice(0, 6);
          e.target.value = code;
        },
      });
      formArea.replaceChildren(
        h('form', { onsubmit: verify },
          h('p', { class: 'lead' }, t('login.codeSent', { email })),
          field('code', t('login.code'), input),
          consentBox(),
          h('button', { class: 'btn btn-primary btn-block', type: 'submit', disabled: busy }, busy ? t('login.verifying') : t('login.verify')),
          h('div', { class: 'row-links' },
            h('button', { class: 'link', type: 'button', 'data-resend': true, disabled: cooldown > 0 || busy, onclick: requestCode },
              cooldown > 0 ? t('login.resendIn', { s: cooldown }) : t('login.resend')),
            h('button', { class: 'link', type: 'button', onclick: () => { step = 'email'; setError(''); draw(true); } }, t('login.change')),
          ),
        ),
      );
      if (focus || step === 'code') input.focus();
    }
  }

  async function setupGoogle() {
    if (!config.googleClientId) return;
    try {
      await loadGoogleScript();
      if (!googleReady) {
        window.google.accounts.id.initialize({
          client_id: config.googleClientId,
          callback: (resp) => googleHandler?.(resp),
          ux_mode: 'popup',
          auto_select: false,
        });
        googleReady = true;
      }
      window.google.accounts.id.renderButton(googleBtn, {
        theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 300, locale: getLang() === 'ms' ? 'ms' : 'en',
      });
      googleBlock.hidden = step !== 'email';
    } catch {
      /* Google is unreachable (offline or blocked): email codes still work */
    }
  }

  draw();
  setupGoogle();

  return h('div', { class: 'container narrow' },
    h('div', { class: 'card login-card' },
      h('h1', {}, t(asProvider ? 'login.title.provider' : 'login.title')),
      h('p', { class: 'muted' }, t(asProvider ? 'login.sub.provider' : 'login.sub')),
      errorBox, googleBlock, formArea,
    ),
  );
}
