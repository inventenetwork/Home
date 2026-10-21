import { api, isLoggedIn } from '../api.js';
import { fmtDay, fmtDuration, hasKey, t } from '../i18n.js';
import { banner, config, errText, field, h, money, mytDate, unitWord } from '../ui.js';

const MAX_UNITS = 50;

// The form is kept in sessionStorage, so it survives a language switch, a trip to the login page, and "book again" prefill.
const draftKey = (slug) => `h360.draft.${slug}`;
export function loadDraft(slug) {
  try {
    return JSON.parse(sessionStorage.getItem(draftKey(slug))) ?? {};
  } catch {
    return {};
  }
}
export function saveDraft(slug, draft) {
  try {
    sessionStorage.setItem(draftKey(slug), JSON.stringify(draft));
  } catch { /* private mode: the form just won't survive a reload */ }
}
const clearDraft = (slug) => {
  try {
    sessionStorage.removeItem(draftKey(slug));
  } catch { /* ignore */ }
};

const humanize = (key) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const groupLabel = (key) => (hasKey(`group.${key}`) ? t(`group.${key}`) : humanize(key));

export async function bookPage(ctx) {
  const slug = ctx.params[0];
  const service = await api('GET', `/services/${slug}`, { auth: false });
  const back = h('a', { class: 'back', href: '#/' }, t('book.back'));

  if (service.pricingModel === 'quote') {
    return h('div', { class: 'container narrow' }, back, h('h1', {}, service.name), banner('info', t('book.quote')));
  }

  const [{ areas }, addrRes] = await Promise.all([
    api('GET', '/areas', { auth: false }),
    isLoggedIn() ? api('GET', '/addresses') : { addresses: [] },
  ]);
  let addresses = addrRes.addresses;

  const perSize = service.pricingModel === 'per_size';
  const minUnits = Math.max(1, service.minUnits || 1);
  const groups = service.optionGroups;
  const clampUnits = (n) => (Number.isFinite(n) ? Math.min(MAX_UNITS, Math.max(minUnits, Math.trunc(n))) : minUnits);

  // ── state ──
  const draft = loadDraft(slug);
  const state = {
    units: perSize ? 1 : clampUnits(draft.units ?? minUnits),
    options: draft.options ?? {},
    addressId: draft.addressId ?? null,
    date: draft.date && draft.date >= mytDate(0) ? draft.date : mytDate(1),
    slot: draft.slot ?? null,
    notes: draft.notes ?? '',
  };
  if (state.addressId && !addresses.some((a) => a.id === state.addressId)) state.addressId = null;
  if (!state.addressId && addresses.length === 1) state.addressId = addresses[0].id;
  const persist = () => saveDraft(slug, state);

  const defaultOf = (g) => g.options.find((o) => o.isDefault)?.code ?? null;
  const chosen = (g) => {
    const c = g.key in state.options ? state.options[g.key] : defaultOf(g);
    return c === null || g.options.some((o) => o.code === c) ? c : defaultOf(g);
  };
  const selection = () => groups.flatMap((g) => (chosen(g) ? [{ group: g.key, code: chosen(g) }] : []));
  const currentAddress = () => addresses.find((a) => a.id === state.addressId) ?? null;

  let est = null;
  let estError = '';
  let slotData = null; // null | { loading } | { error } | { slots }
  let bookingBusy = false;
  let submitError = '';
  let showAddressForm = addresses.length === 0;

  const detailsBox = h('div');
  const addressBox = h('div');
  const whenBox = h('div');
  const slotsBox = h('div', { 'aria-live': 'polite' });
  const summaryBox = h('div');

  const goLogin = () => {
    persist();
    ctx.navigate(`#/login?next=${encodeURIComponent(`#/book/${slug}`)}`);
  };

  // ── 1. service details ──
  function setUnits(n) {
    state.units = clampUnits(n);
    state.slot = null;
    persist();
    renderDetails();
    refreshEstimate();
    loadSlots();
  }

  function optionPrice(o) {
    if (!o.priceCents) return '';
    if (o.perUnit && o.kind !== 'size') return t('opt.perUnit', { price: money(o.priceCents) });
    return (o.kind === 'addon' ? '+' : '') + money(o.priceCents);
  }

  function optionCard(g, o, type, checked, onChange) {
    return h('label', { class: `opt${checked ? ' selected' : ''}` },
      h('input', { type, name: `grp-${g.key}`, checked, onchange: onChange }),
      h('span', { class: 'opt-label' }, o.label),
      h('span', { class: 'opt-price' }, optionPrice(o)),
    );
  }

  function groupField(g) {
    const cur = chosen(g);
    const pick = (code) => () => {
      state.options[g.key] = code;
      persist();
      renderDetails();
      refreshEstimate();
    };
    const single = g.options.length === 1 && g.options[0].kind === 'addon' && !g.options[0].isDefault;
    if (single) {
      const o = g.options[0];
      return h('fieldset', { class: 'group' }, h('legend', {}, groupLabel(g.key)),
        optionCard(g, o, 'checkbox', cur === o.code, (e) => pick(e.target.checked ? o.code : null)()));
    }
    const cards = g.options.map((o) => optionCard(g, o, 'radio', cur === o.code, pick(o.code)));
    if (!g.required && !defaultOf(g)) {
      cards.push(optionCard(g, { label: t('opt.none'), priceCents: 0, kind: 'addon' }, 'radio', cur === null, pick(null)));
    }
    return h('fieldset', { class: 'group' }, h('legend', {}, groupLabel(g.key)), cards);
  }

  function renderDetails() {
    const kids = [];
    if (!perSize) {
      kids.push(
        h('div', { class: 'field' },
          h('label', { for: 'units' }, t('book.units', { things: unitWord(service.unitLabel, true) })),
          h('div', { class: 'stepper' },
            h('button', { type: 'button', class: 'btn btn-ghost step', 'aria-label': '−', disabled: state.units <= minUnits, onclick: () => setUnits(state.units - 1) }, '−'),
            h('input', { id: 'units', type: 'number', inputmode: 'numeric', min: minUnits, max: MAX_UNITS, step: 1, value: String(state.units),
              onchange: (e) => setUnits(parseInt(e.target.value, 10)) }),
            h('button', { type: 'button', class: 'btn btn-ghost step', 'aria-label': '+', disabled: state.units >= MAX_UNITS, onclick: () => setUnits(state.units + 1) }, '+'),
          ),
        ),
      );
    }
    kids.push(...groups.map(groupField));
    detailsBox.replaceChildren(...kids);
  }

  // ── 2. address ──
  function addressCard(a) {
    return h('label', { class: `opt${a.id === state.addressId ? ' selected' : ''}` },
      h('input', { type: 'radio', name: 'address', checked: a.id === state.addressId, onchange: () => {
        state.addressId = a.id;
        state.slot = null;
        persist();
        renderAddress();
        loadSlots();
      } }),
      h('span', { class: 'opt-label' },
        h('strong', {}, a.label), h('br'),
        `${a.line1}${a.line2 ? `, ${a.line2}` : ''}, ${a.postcode}${a.area ? ` ${a.area.name}` : ''}`),
    );
  }

  function addressForm() {
    const v = { label: '', line1: '', line2: '', postcode: '', areaSlug: '' };
    const msg = h('div');
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, t('book.address.save'));
    const input = (id, key, label, attrs = {}) =>
      field(`addr-${id}`, label, h('input', { id: `addr-${id}`, value: v[key], oninput: (e) => (v[key] = e.target.value), ...attrs }));
    return h('form', { class: 'address-form', onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      submit.textContent = t('book.address.saving');
      msg.replaceChildren();
      try {
        const a = await api('POST', '/addresses', { body: {
          label: v.label.trim() || 'Home', line1: v.line1.trim(), ...(v.line2.trim() ? { line2: v.line2.trim() } : {}),
          postcode: v.postcode.trim(), areaSlug: v.areaSlug } });
        addresses = [...addresses, a];
        state.addressId = a.id;
        state.slot = null;
        showAddressForm = false;
        persist();
        renderAddress();
        loadSlots();
      } catch (err) {
        submit.disabled = false;
        submit.textContent = t('book.address.save');
        msg.replaceChildren(banner('error', errText(err)));
      }
    } },
      input('label', 'label', t('book.address.label'), { maxlength: 40, autocomplete: 'off' }),
      input('line1', 'line1', t('book.address.line1'), { required: true, minlength: 3, maxlength: 200, autocomplete: 'address-line1' }),
      input('line2', 'line2', t('book.address.line2'), { maxlength: 200, autocomplete: 'address-line2' }),
      h('div', { class: 'two' },
        input('postcode', 'postcode', t('book.address.postcode'), { required: true, pattern: '[0-9]{5}', maxlength: 5, inputmode: 'numeric', autocomplete: 'postal-code' }),
        field('addr-area', t('book.address.area'),
          h('select', { id: 'addr-area', required: true, onchange: (e) => (v.areaSlug = e.target.value) },
            h('option', { value: '' }, t('book.address.choose')),
            areas.map((a) => h('option', { value: a.slug }, a.name)))),
      ),
      msg, submit,
    );
  }

  function renderAddress() {
    if (!isLoggedIn()) {
      addressBox.replaceChildren(
        h('p', { class: 'muted' }, t('book.address.login')),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: goLogin }, t('nav.login')),
      );
      return;
    }
    addressBox.replaceChildren(
      ...addresses.map(addressCard),
      showAddressForm
        ? addressForm()
        : h('button', { class: 'link', type: 'button', onclick: () => { showAddressForm = true; renderAddress(); } }, `+ ${t('book.address.add')}`),
    );
  }

  // ── 3. date and time ──
  function setDate(d) {
    if (!d) return;
    state.date = d;
    state.slot = null;
    persist();
    renderWhen();
    loadSlots();
  }

  function renderWhen() {
    const chips = Array.from({ length: 14 }, (_, i) => mytDate(i)).map((d) =>
      h('button', { type: 'button', class: `chip${d === state.date ? ' selected' : ''}`, 'aria-pressed': d === state.date, onclick: () => setDate(d) },
        h('span', { class: 'chip-wd' }, fmtDay(d, { weekday: 'short' })),
        h('span', { class: 'chip-day' }, fmtDay(d, { day: 'numeric' })),
        h('span', { class: 'chip-mo' }, fmtDay(d, { month: 'short' })),
      ),
    );
    whenBox.replaceChildren(
      h('div', { class: 'chips', role: 'group', 'aria-label': t('book.when') }, chips),
      h('div', { class: 'other-date' },
        h('label', { for: 'other-date' }, t('book.otherDate')),
        h('input', { id: 'other-date', type: 'date', min: mytDate(0), max: mytDate(config.maxAdvanceDays), value: state.date, onchange: (e) => setDate(e.target.value) })),
      slotsBox,
    );
  }

  function renderSlots() {
    if (!currentAddress()) {
      slotsBox.replaceChildren(h('p', { class: 'muted' }, t('book.slots.pickAddress')));
    } else if (!slotData || slotData.loading) {
      slotsBox.replaceChildren(h('p', { class: 'muted' }, t('book.slots.loading')));
    } else if (slotData.error) {
      slotsBox.replaceChildren(banner('error', slotData.error));
    } else if (!slotData.slots.some((s) => s.available)) {
      slotsBox.replaceChildren(h('p', { class: 'muted' }, t('book.slots.none')));
    } else {
      slotsBox.replaceChildren(
        h('div', { class: 'slots', role: 'group', 'aria-label': fmtDay(state.date, { weekday: 'long', day: 'numeric', month: 'long' }) },
          slotData.slots.map((s) =>
            h('button', {
              type: 'button', class: `slot${s.start === state.slot ? ' selected' : ''}`, disabled: !s.available,
              'aria-pressed': s.start === state.slot, title: s.available ? '' : t(`book.slot.${s.reason}`),
              onclick: () => { state.slot = s.start; persist(); renderSlots(); renderSummary(); },
            }, s.time)),
        ),
      );
    }
  }

  let slotReq = 0;
  async function loadSlots() {
    const addr = currentAddress();
    const my = ++slotReq;
    if (!addr?.area || !state.date) {
      slotData = null;
      renderSlots();
      renderSummary();
      return;
    }
    slotData = { loading: true };
    renderSlots();
    try {
      const res = await api('GET', `/services/${slug}/slots`, {
        auth: false,
        query: { date: state.date, area: addr.area.slug, ...(perSize ? {} : { units: state.units }) },
      });
      if (my !== slotReq) return;
      slotData = res;
      if (state.slot && !res.slots.some((s) => s.start === state.slot && s.available)) {
        state.slot = null;
        persist();
      }
    } catch (err) {
      if (my !== slotReq) return;
      slotData = { error: errText(err) };
    }
    renderSlots();
    renderSummary();
  }

  // ── price + booking ──
  let estReq = 0;
  async function refreshEstimate() {
    const my = ++estReq;
    try {
      const r = await api('POST', `/services/${slug}/estimate`, {
        auth: false, body: { ...(perSize ? {} : { units: state.units }), options: selection() },
      });
      if (my !== estReq) return;
      est = r;
      estError = '';
    } catch (err) {
      if (my !== estReq) return;
      est = null;
      estError = errText(err);
    }
    renderSummary();
  }

  // Repeat visits (not saved in the draft: starting a plan should always be a deliberate choice).
  const repeat = { freq: '', sessions: '4', keep: true };
  const repeatBox = h('div', { class: 'repeat-box' });
  function drawRepeat() {
    const sel = (id, opts, val, on) => h('select', { id, onchange: (e) => on(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
    repeatBox.replaceChildren(...[
      h('label', { for: 'rep-freq' }, t('rep.freq')),
      sel('rep-freq', [['', t('rep.once')], ['weekly', t('plan.weekly')], ['biweekly', t('plan.biweekly')], ['monthly', t('plan.monthly')]], repeat.freq, (v) => { repeat.freq = v; drawRepeat(); }),
      repeat.freq ? h('label', { for: 'rep-n' }, t('rep.sessions')) : null,
      repeat.freq ? sel('rep-n', [['4', '4'], ['8', '8'], ['12', '12'], ['open', t('rep.open')]], repeat.sessions, (v) => { repeat.sessions = v; }) : null,
      repeat.freq ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: repeat.keep, onchange: (e) => { repeat.keep = e.target.checked; } }), ' ', t('rep.keep')) : null,
      repeat.freq ? h('p', { class: 'muted small' }, t('rep.note')) : null,
    ].filter(Boolean));
  }
  drawRepeat();

  async function submit() {
    if (!isLoggedIn()) return goLogin();
    bookingBusy = true;
    submitError = '';
    renderSummary();
    try {
      const body = {
        serviceSlug: slug, addressId: state.addressId, scheduledAt: state.slot,
        ...(perSize ? {} : { units: state.units }), options: selection(),
        ...(state.notes.trim() ? { notes: state.notes.trim() } : {}),
      };
      const b = repeat.freq
        ? await api('POST', '/recurring', { body: { ...body, frequency: repeat.freq, sessions: repeat.sessions === 'open' ? null : Number(repeat.sessions), keepProvider: repeat.keep } }).then((r) => ({ id: r.bookingId }))
        : await api('POST', '/bookings', { body });
      clearDraft(slug);
      ctx.navigate(`#/bookings/${b.id}?new=1`);
      return;
    } catch (err) {
      if (err.status === 401) return goLogin();
      submitError = errText(err);
      if (['slot_unavailable', 'invalid_slot', 'too_soon', 'outside_hours'].includes(err.code)) {
        state.slot = null;
        persist();
        loadSlots();
      }
    }
    bookingBusy = false;
    renderSummary();
  }

  function renderSummary() {
    const missing = [];
    if (!isLoggedIn()) missing.push(t('sum.need.login'));
    else if (!state.addressId) missing.push(t('sum.need.address'));
    if (!state.slot) missing.push(t('sum.need.slot'));

    const kids = [h('h2', {}, t('sum.title'))];
    if (estError) kids.push(banner('error', estError));
    else if (!est) kids.push(h('div', { class: 'skeleton' }));
    else {
      kids.push(
        ...est.lineItems.map((li) =>
          h('div', { class: 'price-line' }, h('span', {}, li.qty > 1 ? `${li.label} × ${li.qty}` : li.label), h('span', { class: 'amt' }, money(li.amountCents)))),
      );
      if (est.sstCents > 0) {
        kids.push(
          h('div', { class: 'price-line muted' }, h('span', {}, t('sum.subtotal')), h('span', { class: 'amt' }, money(est.subtotalCents))),
          h('div', { class: 'price-line muted' }, h('span', {}, t('sum.sst')), h('span', { class: 'amt' }, money(est.sstCents))),
        );
      }
      kids.push(h('div', { class: 'price-line total' }, h('span', {}, t('sum.total')), h('span', { class: 'amt' }, money(est.totalCents))));
      const minutes = (service.fixedMinutes || 0) + (service.minutesPerUnit || 0) * est.units;
      if (minutes > 0) kids.push(h('p', { class: 'muted small' }, t('sum.duration', { d: fmtDuration(minutes) })));
    }
    if (submitError) kids.push(banner('error', submitError));
    if (state.slot && currentAddress()) {
      kids.push(h('p', { class: 'when' }, `${fmtDay(state.date, { weekday: 'long', day: 'numeric', month: 'long' })}, ${slotData?.slots?.find((s) => s.start === state.slot)?.time ?? ''}`));
    }
    kids.push(
      h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: bookingBusy || !est || missing.length > 0, onclick: submit },
        bookingBusy ? t('sum.booking') : t('sum.book')),
      missing.length ? h('p', { class: 'muted small' }, t('sum.need', { what: missing.join(', ') })) : null,
      h('p', { class: 'muted small' }, t('sum.payNote', { m: config.pendingExpiryMinutes })),
    );
    summaryBox.replaceChildren(...kids.filter(Boolean)); // replaceChildren would print a literal "null"
  }

  const notes = h('textarea', {
    id: 'notes', rows: 3, maxlength: 500, placeholder: t('book.notes.ph'), value: state.notes,
    oninput: (e) => { state.notes = e.target.value; persist(); },
  });

  renderDetails();
  renderAddress();
  renderWhen();
  renderSlots();
  renderSummary();
  refreshEstimate();
  loadSlots();

  const section = (n, title, ...body) => h('section', { class: 'card step-card' }, h('h2', {}, h('span', { class: 'step-no' }, String(n)), title), ...body);

  return h('div', { class: 'container' },
    back,
    h('div', { class: 'book-head' }, h('h1', {}, service.name), h('p', { class: 'muted' }, service.description)),
    h('div', { class: 'book-layout' },
      h('div', { class: 'book-main' },
        section(1, t('book.details'), detailsBox),
        section(2, t('book.address'), addressBox),
        section(3, t('book.when'), whenBox),
        section(4, t('book.notes'), notes),
        section(5, t('rep.title'), repeatBox),
      ),
      h('aside', { class: 'card summary' }, summaryBox),
    ),
  );
}
