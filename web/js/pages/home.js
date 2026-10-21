import { api } from '../api.js';
import { t } from '../i18n.js';
import { h, money, serviceIcon, unitWord } from '../ui.js';

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

  return h('div', { class: 'container' },
    h('section', { class: 'hero' }, h('h1', {}, t('home.title')), h('p', { class: 'lead' }, t('home.sub'))),
    cards.length ? h('div', { class: 'service-grid' }, cards) : h('p', { class: 'muted' }, t('home.empty')),
    h('p', { class: 'provider-cta' }, h('a', { href: '#/login?as=provider', 'data-join-provider': true }, t('home.provider'))),
  );
}
