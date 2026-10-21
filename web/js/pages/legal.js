// Terms of Use and Privacy Notice pages. Text lives in ../legal-text.js; company and contact come from /config.
import { getLang } from '../i18n.js';
import { LEGAL } from '../legal-text.js';
import { config, h } from '../ui.js';

const fill = (s) => s.replaceAll('{company}', config.legal?.company ?? 'Home360').replaceAll('{email}', config.legal?.email ?? '');

function section([heading, paras]) {
  const kids = [];
  let list = null;
  for (const p of paras) {
    if (p.startsWith('- ')) {
      if (!list) kids.push((list = h('ul', {})));
      list.append(h('li', {}, fill(p.slice(2))));
    } else {
      list = null;
      kids.push(h('p', {}, fill(p)));
    }
  }
  return h('section', {}, h('h2', {}, heading), ...kids);
}

function legalPage(kind) {
  const L = LEGAL[getLang()] ?? LEGAL.en;
  const other = kind === 'terms' ? 'privacy' : 'terms';
  return h('div', { class: 'container narrow-lg legal' },
    h('h1', {}, kind === 'terms' ? L.termsTitle : L.privacyTitle),
    h('p', { class: 'muted small' }, L.updated.replace('{v}', config.legal?.version ?? '')),
    config.paymentGateway === 'fake' ? h('p', { class: 'banner banner-info' }, L.draftNote) : null,
    h('p', {}, fill(kind === 'terms' ? L.termsIntro : L.privacyIntro)),
    ...(kind === 'terms' ? L.terms : L.privacy).map(section),
    h('p', {}, h('a', { href: `#/${other}` }, other === 'terms' ? L.termsTitle : L.privacyTitle)),
  );
}

export const termsPage = () => legalPage('terms');
export const privacyPage = () => legalPage('privacy');
