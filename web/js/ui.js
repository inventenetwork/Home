import { getLang, hasKey, t } from './i18n.js';

/** Public settings from GET /config; filled in by app.js. */
export const config = { googleClientId: null, pendingExpiryMinutes: 30, maxAdvanceDays: 60, minLeadHours: 24, freeCancelHours: 12, paymentGateway: null, legal: null, demo: null };

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate']);

/**
 * Tiny DOM builder. Text is always added as text nodes, never as HTML, so server data cannot inject markup.
 *   h('button', { class: 'btn', onclick: fn }, 'Save')
 */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  const late = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROP_KEYS.has(k)) late.push([k, v]); // set after children so <select value> works
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  for (const [k, v] of late) el[k] = v;
  return el;
}

/** Trusted, constant SVG markup only (never pass server data here). */
export function svg(markup, cls = 'icon') {
  const span = document.createElement('span');
  span.className = cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = markup;
  return span;
}

const ICON = (inner) =>
  `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  'home-cleaning': ICON('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>'),
  'ironing-laundry': ICON('<path d="M8 3L3 6l2.5 4L8 9v12h8V9l2.5 1L21 6l-5-3c-.5 1.5-2 2.5-4 2.5S8.5 4.5 8 3z"/>'),
  'deep-cleaning': ICON('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M12 13v4M10 15h4"/>'),
  'aircon-service': ICON('<path d="M12 2v20M4 7l16 10M4 17L20 7"/><path d="M10 3.5l2 2 2-2M10 20.5l2-2 2 2"/>'),
  default: ICON('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'),
};
export const serviceIcon = (slug) => svg(ICONS[slug] ?? ICONS.default, 'icon service-icon');

export function money(cents) {
  return `RM ${(cents / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Malaysia calendar date (UTC+8, no DST) as YYYY-MM-DD, `offsetDays` from today. */
export function mytDate(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function fmtClock(iso) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(iso));
}

/** A moment shown in Malaysia time, e.g. "Fri, 23 Oct, 09:00". */
export function fmtWhen(iso) {
  return new Intl.DateTimeFormat(getLang() === 'ms' ? 'ms-MY' : 'en-MY', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kuala_Lumpur',
  }).format(new Date(iso));
}

export const fmtCountdown = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function unitWord(unit, plural = false) {
  const key = `${plural ? 'units' : 'unit'}.${unit}`;
  return hasKey(key) ? t(key) : unit ?? '';
}

/** Customer-friendly text for an API error. */
export function errText(err) {
  const code = err?.code;
  if (code) {
    const key = `err.${code}`;
    if (hasKey(key)) {
      return t(key, { h: config.minLeadHours, d: config.maxAdvanceDays });
    }
  }
  if (err?.name === 'ApiError' && err.status >= 400 && err.status < 500) {
    if (err.details?.length) return err.details.join('. ');
    if (err.message && err.message !== err.code) return err.message; // server text (English) for codes we have not translated
  }
  return t('err.generic');
}

// ── small shared widgets ──

export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(el);
  setTimeout(() => el.remove(), 5000);
}

export const loading = () => h('div', { class: 'container loading', role: 'status' }, h('div', { class: 'spinner' }), h('span', { class: 'sr' }, '…'));

export function banner(kind, ...kids) {
  return h('div', { class: `banner banner-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, ...kids);
}

export function statusBadge(status) {
  return h('span', { class: `badge badge-${status}` }, t(`status.${status}`));
}

export function field(id, label, input, hint) {
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
}

export function priceLine(label, cents, cls = '') {
  return h('div', { class: `price-line ${cls}` }, h('span', {}, label), h('span', { class: 'amt' }, money(cents)));
}

export function debounce(fn, ms) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}

export const localeCode = () => (getLang() === 'ms' ? 'ms-MY' : 'en-MY');

/**
 * A button that opens the camera or photo picker. The chosen file is passed to onFile(file).
 * capture: 'environment' (back camera) or 'user' (selfie camera) on phones; ignored on computers.
 */
export function fileButton({ label, capture, disabled, onFile, cls = 'btn btn-ghost btn-sm', name }) {
  const input = h('input', {
    type: 'file', accept: 'image/*', capture, hidden: true, tabindex: '-1', 'data-file': name,
    onchange: (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (f) onFile(f);
    },
  });
  const btn = h('button', { type: 'button', class: cls, disabled, onclick: () => input.click() }, label);
  return h('span', { class: 'file-btn' }, btn, input);
}

/** Shrinks a photo in the browser (phone cameras take 5-10 MB pictures) and returns a JPEG data URL under the server's 3 MB limit. */
export async function imageToDataUrl(file, maxDim = 1600) {
  const bad = () => Object.assign(new Error('invalid_image'), { name: 'ApiError', code: 'invalid_image', status: 400 });
  if (!file.type.startsWith('image/')) throw bad();
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw bad(); // for example an iPhone HEIC file the browser cannot decode
  }
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', 0.82);
}
