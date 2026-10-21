import { getUser, isLoggedIn, logout, onAuthChange, restoreSession, ApiError, api } from './api.js';
import { getLang, setLang, t } from './i18n.js';
import { bookPage } from './pages/book.js';
import { adminPage } from './pages/admin.js';
import { bookingDetailPage, bookingsPage } from './pages/bookings.js';
import { accountPage } from './pages/account.js';
import { privacyPage, termsPage } from './pages/legal.js';
import { plansPage, providerReviewsPage } from './pages/extras.js';
import { homePage } from './pages/home.js';
import { joinPage } from './pages/join.js';
import { loginPage } from './pages/login.js';
import { providerJobsPage, providerOffersPage } from './pages/provider.js';
import { providerCalendarPage, providerEarningsPage, providerProfilePage } from './pages/provider-account.js';
import { config, errText, h, loading } from './ui.js';

const main = document.getElementById('main');
const topbar = document.getElementById('topbar');
const footer = document.getElementById('footer');

const navigate = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

const routes = [
  [/^\/$/, homePage],
  [/^\/join$/, joinPage],
  [/^\/login$/, loginPage],
  [/^\/book\/([a-z0-9-]{1,60})$/, bookPage],
  [/^\/bookings$/, bookingsPage],
  [/^\/bookings\/([0-9a-f-]{36})$/, bookingDetailPage],
  [/^\/provider$/, providerOffersPage],
  [/^\/provider\/jobs$/, providerJobsPage],
  [/^\/provider\/calendar$/, providerCalendarPage],
  [/^\/provider\/earnings$/, providerEarningsPage],
  [/^\/provider\/profile$/, providerProfilePage],
  [/^\/provider\/reviews$/, providerReviewsPage],
  [/^\/plans$/, plansPage],
  [/^\/account$/, accountPage],
  [/^\/terms$/, termsPage],
  [/^\/privacy$/, privacyPage],
  [/^\/admin$/, adminPage],
];

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  return { path, query: Object.fromEntries(new URLSearchParams(q === -1 ? '' : raw.slice(q + 1))) };
}

function renderTopbar() {
  const user = getUser();
  const langBtn = (code, label) =>
    h('button', { type: 'button', class: `lang${getLang() === code ? ' on' : ''}`, 'aria-pressed': getLang() === code, onclick: () => { setLang(code); render(); } }, label);
  topbar.replaceChildren(
    h('div', { class: 'container bar' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: '/img/logo.svg', alt: '', width: 32, height: 32 }), h('span', {}, 'Home360')),
      h('nav', { 'aria-label': 'Main' },
        user?.role === 'provider' ? h('a', { href: '#/provider' }, t('nav.provider')) : null,
        user && user.role !== 'provider' ? h('a', { href: '#/bookings' }, t('nav.bookings')) : null,
        user?.role === 'customer' ? h('a', { href: '#/plans' }, t('nav.plans')) : null,
        user?.role === 'admin' ? h('a', { href: '#/admin' }, t('nav.admin')) : null,
        user ? h('a', { href: '#/account' }, t('nav.account')) : null,
        h('div', { class: 'langs', role: 'group', 'aria-label': t('nav.lang') }, langBtn('en', 'EN'), langBtn('ms', 'BM')),
        isLoggedIn()
          ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: user?.email ?? '', onclick: () => { logout(); navigate('#/'); } }, t('nav.logout'))
          : h('a', { class: 'btn btn-primary btn-sm', href: `#/login?next=${encodeURIComponent(location.hash || '#/')}` }, t('nav.login')),
      ),
    ),
  );
  document.querySelector('.skip').textContent = t('skip');
  footer.replaceChildren(h('div', { class: 'container' }, h('p', {}, `${t('brand.tag')}`), h('p', { class: 'small' }, t('footer.areas')),
    h('p', { class: 'small' }, h('a', { href: '#/terms' }, t('footer.terms')), ' · ', h('a', { href: '#/privacy' }, t('footer.privacy')))));
}

function errorPanel(err) {
  const notFound = err instanceof ApiError && err.status === 404;
  return h('div', { class: 'container narrow' },
    h('div', { class: 'card empty' },
      h('p', { role: 'alert' }, notFound ? t('err.not_found') : errText(err)),
      notFound
        ? h('a', { class: 'btn btn-primary', href: '#/' }, t('home'))
        : h('button', { class: 'btn btn-primary', type: 'button', onclick: render }, t('retry')),
    ),
  );
}

let cleanups = [];
let renderId = 0;
let lastPath = null;

async function render() {
  const id = ++renderId;
  cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  cleanups = [];
  renderTopbar();

  const { path, query } = parseHash();
  let handler = null;
  let params = [];
  for (const [re, fn] of routes) {
    const m = re.exec(path);
    if (m) { handler = fn; params = m.slice(1); break; }
  }
  main.replaceChildren(loading());
  try {
    const node = handler
      ? await handler({ params, query, navigate, rerender: render, onCleanup: (fn) => cleanups.push(fn) })
      : errorPanel(new ApiError(404, 'not_found'));
    if (id !== renderId) return;
    main.replaceChildren(node);
  } catch (err) {
    if (id !== renderId) return;
    if (err instanceof ApiError && err.status === 401) {
      navigate(`#/login?next=${encodeURIComponent(location.hash)}`);
      return;
    }
    main.replaceChildren(errorPanel(err));
  }
  if (path !== lastPath) {
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }
  lastPath = path;
}

onAuthChange(renderTopbar);
window.addEventListener('hashchange', render);

try {
  Object.assign(config, await api('GET', '/config', { auth: false }));
} catch { /* defaults are fine; the first real call will show a network error */ }
await restoreSession();
render();
