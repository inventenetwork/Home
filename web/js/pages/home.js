import { api } from '../api.js';
import { t } from '../i18n.js';
import { h, money, serviceIcon, svg, unitWord } from '../ui.js';

const ICON = (inner) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const TRUST = [
  ['shield', ICON('<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'), 'home.trust.vetted'],
  ['tag', ICON('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>'), 'home.trust.price'],
  ['lock', ICON('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'), 'home.trust.escrow'],
  ['wallet', ICON('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/>'), 'home.trust.pay'],
];
const STEPS = ['home.step1', 'home.step2', 'home.step3'];
const AREAS = ['Kuching', 'Sibu', 'Petaling Jaya', 'Subang', 'Kepong'];

// A friendly house with sparkles. Constant, trusted markup.
const HERO_ART = `<svg viewBox="0 0 320 260" role="img" aria-label="" width="320" height="260">
  <circle cx="160" cy="130" r="118" fill="#ffffff" fill-opacity="0.10"/>
  <circle cx="160" cy="130" r="84" fill="#ffffff" fill-opacity="0.10"/>
  <path d="M70 130l90-72 90 72v84a8 8 0 01-8 8H78a8 8 0 01-8-8z" fill="#ffffff"/>
  <path d="M58 134l102-82 102 82" fill="none" stroke="#fbbf24" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="136" y="160" width="48" height="62" rx="6" fill="#0f766e"/>
  <circle cx="174" cy="192" r="3.5" fill="#fbbf24"/>
  <rect x="88" y="148" width="34" height="30" rx="5" fill="#99e6dc"/>
  <rect x="198" y="148" width="34" height="30" rx="5" fill="#99e6dc"/>
  <path d="M252 62l4 12 12 4-12 4-4 12-4-12-12-4 12-4z" fill="#fbbf24"/>
  <path d="M64 70l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#ffffff"/>
  <path d="M276 150l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z" fill="#ffffff" fill-opacity="0.8"/>
</svg>`;

/** "From RM x": the price with minimum quantity and default options, straight from the server's estimate. */
async function fromPrice(slug) {
  try {
    const r = await api('POST', `/services/${slug}/estimate`, { auth: false, body: { options: [] } });
    return r.quoteOnly ? null : r.totalCents;
  } catch {
    return null;
  }
}

export async function homePage() {
  const { services } = await api('GET', '/services', { auth: false });
  const prices = await Promise.all(services.map((s) => (s.pricingModel === 'quote' ? null : fromPrice(s.slug))));

  const cards = services.map((s, i) => {
    const quote = s.pricingModel === 'quote';
    const unit = s.unitLabel ? unitWord(s.unitLabel) : '';
    // Unit-priced services show their unit price; everything else shows the price of the default, minimum booking.
    let priceText = '';
    if (quote) priceText = t('svc.quote');
    else if ((s.pricingModel === 'hourly' || s.pricingModel === 'per_unit') && s.basePriceCents > 0) priceText = t('svc.per', { price: money(s.basePriceCents), unit });
    else if (prices[i] != null) priceText = t('svc.from', { price: money(prices[i]) });

    const inner = [
      serviceIcon(s.slug),
      h('h2', {}, s.name),
      h('p', { class: 'muted' }, s.description),
      h('div', { class: 'service-foot' },
        h('strong', {}, priceText),
        quote ? null : h('span', { class: 'btn btn-primary btn-sm' }, t('svc.book')),
      ),
    ];
    return quote
      ? h('div', { class: 'card service-card disabled' }, inner)
      : h('a', { class: 'card service-card', href: `#/book/${s.slug}` }, inner);
  });

  const toServices = () => document.getElementById('services')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return h('div', { class: 'landing' },
    h('section', { class: 'landing-hero' },
      h('div', { class: 'container landing-hero-inner' },
        h('div', { class: 'landing-copy' },
          h('p', { class: 'eyebrow' }, t('home.eyebrow')),
          h('h1', {}, t('home.title')),
          h('p', { class: 'landing-sub' }, t('home.sub')),
          h('div', { class: 'landing-cta' },
            h('button', { class: 'btn btn-accent btn-lg', type: 'button', onclick: toServices }, t('home.cta')),
            h('a', { class: 'btn btn-ghost btn-lg', href: '#/login?as=provider', 'data-join-provider': true }, t('home.cta.provider')),
          ),
        ),
        svg(HERO_ART, 'landing-art'),
      ),
    ),
    h('div', { class: 'container' },
      h('ul', { class: 'trust' },
        TRUST.map(([id, icon, key]) =>
          h('li', { class: 'trust-item', 'data-trust': id }, svg(icon, 'trust-icon'), h('span', {}, t(key)))),
      ),
      h('section', { id: 'services', class: 'block' },
        h('h2', { class: 'block-title' }, t('home.services')),
        h('p', { class: 'muted block-sub' }, t('home.servicesSub')),
        cards.length ? h('div', { class: 'service-grid' }, cards) : h('p', { class: 'muted' }, t('home.empty')),
      ),
      h('section', { class: 'block' },
        h('h2', { class: 'block-title' }, t('home.how')),
        h('ol', { class: 'steps' },
          STEPS.map((k, i) =>
            h('li', { class: 'card how-step' }, h('span', { class: 'step-num' }, String(i + 1)), h('h3', {}, t(`${k}.t`)), h('p', { class: 'muted' }, t(`${k}.d`)))),
        ),
      ),
      h('section', { class: 'block' },
        h('h2', { class: 'block-title' }, t('home.areas')),
        h('ul', { class: 'chips' }, AREAS.map((a) => h('li', { class: 'chip' }, a))),
      ),
      h('section', { class: 'provider-band' },
        h('div', {}, h('h2', {}, t('home.band.title')), h('p', {}, t('home.band.sub'))),
        h('a', { class: 'btn btn-accent btn-lg', href: '#/login?as=provider', 'data-join-provider': true }, t('home.band.cta')),
      ),
    ),
  );
}
