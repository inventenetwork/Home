// My account: correct my details, download my data, delete my account (PDPA).
import { api, apiBlobUrl, getUser, logout } from '../api.js';
import { getLang, setLang, t } from '../i18n.js';
import { banner, errText, field, h, toast } from '../ui.js';

export async function accountPage(ctx) {
  const me = await api('GET', '/auth/me');

  // ── details ──
  const name = h('input', { id: 'acc-name', type: 'text', maxlength: 100, value: me.fullName ?? '', autocomplete: 'name' });
  const phone = h('input', { id: 'acc-phone', type: 'tel', maxlength: 30, value: me.phone ?? '', autocomplete: 'tel', placeholder: '012-345 6789' });
  const lang = h('select', { id: 'acc-lang' },
    h('option', { value: 'en', selected: me.locale === 'en' }, 'English'),
    h('option', { value: 'ms', selected: me.locale === 'ms' }, 'Bahasa Malaysia'));
  const saveErr = h('div');
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, t('account.save'));
  const form = h('form', { class: 'card stack', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    saveErr.replaceChildren();
    saveBtn.disabled = true;
    try {
      const body = { phone: phone.value.trim() === '' ? null : phone.value.trim(), locale: lang.value };
      if (name.value.trim()) body.fullName = name.value.trim();
      const u = await api('PATCH', '/me', { body });
      const user = getUser();
      if (user) { user.fullName = u.fullName; user.locale = u.locale; }
      toast(t('account.saved'), 'success');
      if (u.locale !== getLang()) setLang(u.locale);
      ctx.rerender();
    } catch (err) {
      saveErr.replaceChildren(banner('error', errText(err)));
    } finally {
      saveBtn.disabled = false;
    }
  } },
    h('h2', {}, t('account.details')),
    field('acc-email', t('account.email'), h('input', { id: 'acc-email', type: 'email', value: me.email, disabled: true })),
    field('acc-name', t('account.name'), name),
    field('acc-phone', t('account.phone'), phone),
    field('acc-lang', t('account.lang'), lang),
    saveErr, h('div', {}, saveBtn));

  // ── download ──
  const dlErr = h('div');
  const dlBtn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => {
    dlErr.replaceChildren();
    dlBtn.disabled = true;
    let url;
    try {
      url = await apiBlobUrl('/me/export');
      const a = h('a', { href: url, download: `home360-my-data-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
    } catch (err) {
      dlErr.replaceChildren(banner('error', errText(err)));
    } finally {
      dlBtn.disabled = false;
      if (url) setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  } }, t('account.download'));
  const dataCard = h('div', { class: 'card stack' }, h('h2', {}, t('account.data')), h('p', {}, t('account.data.help')), dlErr, h('div', {}, dlBtn));

  // ── delete ──
  const confirm = h('input', { id: 'acc-confirm', type: 'text', autocomplete: 'off', 'aria-label': t('account.delete.type'), placeholder: 'DELETE' });
  const delErr = h('div');
  const delBtn = h('button', { class: 'btn btn-danger', type: 'button', disabled: true, onclick: async () => {
    delErr.replaceChildren();
    delBtn.disabled = true;
    try {
      await api('POST', '/me/delete', { body: { confirm: confirm.value } });
      await logout();
      toast(t('account.deleted'), 'success');
      ctx.navigate('#/');
    } catch (err) {
      const blocked = err?.code === 'cannot_delete';
      delErr.replaceChildren(banner('error',
        blocked ? h('div', {}, t('account.cannot'), h('ul', {}, ...(err.details ?? []).map((r) => h('li', {}, t(`account.reason.${r}`))))) : errText(err)));
      delBtn.disabled = confirm.value !== 'DELETE';
    }
  } }, t('account.delete.btn'));
  confirm.addEventListener('input', () => { delBtn.disabled = confirm.value !== 'DELETE'; });
  const delCard = me.role === 'admin'
    ? null
    : h('div', { class: 'card stack danger-zone' },
      h('h2', {}, t('account.delete')),
      h('p', {}, t('account.delete.help')),
      h('p', { class: 'muted small' }, t('account.delete.keep')),
      h('label', { for: 'acc-confirm' }, t('account.delete.type')), confirm, delErr, h('div', {}, delBtn));

  return h('div', { class: 'container narrow-lg account' },
    h('h1', {}, t('account.title')), form, dataCard, delCard,
    h('p', { class: 'small muted' }, h('a', { href: '#/terms' }, t('footer.terms')), ' · ', h('a', { href: '#/privacy' }, t('footer.privacy'))));
}
