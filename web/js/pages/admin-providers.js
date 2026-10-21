import { api } from '../api.js';
import { protectedImg } from '../photos.js';
import { banner, errText, fmtWhen, h, money, toast } from '../ui.js';

const STATUSES = ['pending', 'approved', 'rejected', 'suspended', 'all'];
const DOC_LABEL = { id_front: 'ID (front)', id_back: 'ID (back)', selfie: 'Selfie', certificate: 'Certificate', other: 'Other' };

/** Provider vetting: who applied, their documents, approve / reject / suspend. (Admin screens are English only.) */
export async function providersTab(ctx, message, run) {
  const status = STATUSES.includes(ctx.query.status) ? ctx.query.status : 'pending';
  const { providers } = await api('GET', '/admin/providers', { query: { status } });

  function card(p) {
    const panel = h('div');
    let open = false;

    async function showDetail() {
      open = !open;
      if (!open) return panel.replaceChildren();
      panel.replaceChildren(h('p', { class: 'muted' }, '…'));
      try {
        panel.replaceChildren(detailView(await api('GET', `/admin/providers/${p.id}`)));
      } catch (err) {
        panel.replaceChildren(banner('error', errText(err)));
      }
    }

    function detailView(d) {
      const reasonBox = h('textarea', { rows: 2, maxlength: 300, placeholder: 'Reason (shown to the provider)', 'aria-label': 'Reason' });
      const notes = new Map();
      const decide = (action, needsReason, okText) => () => {
        const reason = reasonBox.value.trim();
        if (needsReason && reason.length < 3) return message.replaceChildren(banner('error', 'Please type a short reason first.'));
        return run(() => api('POST', `/admin/providers/${d.id}/${action}`, { body: needsReason ? { reason } : {} }), okText);
      };
      const docCard = (doc) => {
        const note = h('input', { type: 'text', maxlength: 300, placeholder: 'What is wrong?', 'aria-label': `Problem with ${DOC_LABEL[doc.docType]}` });
        notes.set(doc.id, note);
        return h('div', { class: 'admin-doc', 'data-doc-id': doc.id },
          protectedImg(`/admin/providers/${d.id}/documents/${doc.id}/file`, DOC_LABEL[doc.docType] ?? doc.docType, ctx.onCleanup, 'doc-big'),
          h('div', { class: 'small' }, `${DOC_LABEL[doc.docType] ?? doc.docType} · ${doc.reviewStatus}${doc.reviewNote ? ` (${doc.reviewNote})` : ''}`),
          h('div', { class: 'actions' }, note,
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => run(() => api('POST', `/admin/providers/${d.id}/documents/${doc.id}/review`, { body: { status: 'rejected', note: note.value.trim() } }), 'Document flagged.') }, 'Flag problem')));
      };
      const chosen = new Set(d.skillCodes);
      const skillsRow = () => h('div', { class: 'row', 'data-skills': d.id },
        h('dt', {}, 'Services'),
        h('dd', {},
          h('div', { class: 'check-grid' }, d.allSkills.map((s) => h('label', { class: 'check-row' },
            h('input', { type: 'checkbox', name: 'skill', value: s.code, checked: chosen.has(s.code), onchange: (e) => (e.target.checked ? chosen.add(s.code) : chosen.delete(s.code)) }),
            s.name))),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-save-skills': d.id, onclick: () => {
            if (chosen.size === 0) return message.replaceChildren(banner('error', 'Choose at least one service.'));
            return run(() => api('PUT', `/admin/providers/${d.id}/skills`, { body: { skillCodes: [...chosen] } }), (x) => `Services saved.${x.offersWithdrawn ? ` ${x.offersWithdrawn} open offer(s) withdrawn.` : ''}`);
          } }, 'Save services')));
      const row = (k, v) => h('div', { class: 'row' }, h('dt', {}, k), h('dd', {}, v));
      return h('div', { class: 'admin-detail' },
        h('dl', { class: 'facts' },
          row('Email', d.email), row('Phone', d.phone ?? '—'), row('About', d.bio ?? '—'),
          row('Areas', d.areas.join(', ') || '—'), skillsRow(),
          row('Bank', d.bank ? `${d.bank.bankName} · ${d.bank.accountName} · ····${d.bank.last4}` : '—'),
          d.rejectionReason ? row('Last reason', d.rejectionReason) : null,
          d.upcomingJobs ? row('Upcoming jobs', `${d.upcomingJobs} (re-assign them if you suspend this provider)`) : null),
        d.documents.length ? h('div', { class: 'doc-grid' }, d.documents.map(docCard)) : h('p', { class: 'muted' }, 'No documents uploaded.'),
        d.status === 'pending' || d.status === 'rejected' || d.status === 'approved' ? reasonBox : null,
        h('div', { class: 'actions' },
          d.status === 'pending' || d.status === 'rejected' ? h('button', { class: 'btn btn-primary', type: 'button', 'data-approve': d.id, onclick: decide('approve', false, 'Provider approved.') }, 'Approve') : null,
          d.status === 'pending' ? h('button', { class: 'btn btn-danger', type: 'button', 'data-reject': d.id, onclick: decide('reject', true, 'Application rejected.') }, 'Reject') : null,
          d.status === 'approved' ? h('button', { class: 'btn btn-danger', type: 'button', 'data-suspend': d.id, onclick: decide('suspend', true, 'Provider suspended.') }, 'Suspend') : null,
          d.status === 'suspended' ? h('button', { class: 'btn btn-primary', type: 'button', 'data-reinstate': d.id, onclick: decide('reinstate', false, 'Provider reinstated.') }, 'Reinstate') : null),
      );
    }

    return h('div', { class: 'card', 'data-provider': p.id },
      h('div', { class: 'detail-head' },
        h('div', {}, h('strong', {}, p.fullName ?? p.email), h('div', { class: 'muted small' }, `${p.email}${p.phone ? ` · ${p.phone}` : ''}`),
          h('div', { class: 'muted small' }, p.submittedAt ? `Applied ${fmtWhen(p.submittedAt)} · ${p.documents} documents` : `Not submitted yet · ${p.documents} documents`)),
        h('div', { class: 'right' }, h('span', { class: `badge badge-prov-${p.status}` }, p.status), p.status === 'approved' ? h('div', { class: 'muted small' }, `${p.jobsCompleted} jobs`) : null)),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', type: 'button', 'data-review': p.id, onclick: showDetail }, 'Review')),
      panel);
  }

  return [
    h('div', { class: 'tabs sub-tabs', role: 'group' }, STATUSES.map((s) =>
      h('a', { class: `tab${status === s ? ' on' : ''}`, href: `#/admin?tab=providers&status=${s}` }, s[0].toUpperCase() + s.slice(1)))),
    providers.length
      ? h('div', { class: 'list' }, providers.map(card))
      : h('div', { class: 'card empty' }, h('p', {}, status === 'pending' ? 'No applications waiting for review.' : 'No providers here.')),
  ];
}

/** Withdrawals providers have asked for. The admin pays them by bank transfer, then records the reference here. */
export async function payoutsTab(ctx, message, run) {
  const { requests } = await api('GET', '/admin/payouts');
  if (!requests.length) return [h('div', { class: 'card empty' }, h('p', {}, 'No withdrawals waiting.'))];

  const card = (r) => {
    const ref = h('input', { type: 'text', maxlength: 100, placeholder: 'Transfer reference', 'aria-label': 'Transfer reference' });
    const actions = h('div', { class: 'actions' });
    function ask() {
      if (ref.value.trim().length < 3) return message.replaceChildren(banner('error', 'Enter the bank transfer reference first.'));
      message.replaceChildren();
      actions.replaceChildren(
        h('span', { class: 'confirm-ask' }, `I transferred ${money(r.totalCents)} to ${r.bank?.accountName ?? r.providerName}?`),
        h('button', { class: 'btn btn-primary', type: 'button', 'data-confirm-pay': r.providerId, onclick: () => run(() => api('POST', `/admin/payouts/${r.providerId}/pay`, { body: { reference: ref.value.trim() } }), (x) => `Marked ${x.count} job(s) paid.`) }, 'Yes, mark paid'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: drawActions }, 'Back'));
    }
    function drawActions() {
      actions.replaceChildren(ref, h('button', { class: 'btn btn-primary', type: 'button', 'data-pay': r.providerId, onclick: ask }, 'Mark as paid'));
    }
    drawActions();
    const copy = () => navigator.clipboard?.writeText(r.bank.accountNumber).then(() => toast('Account number copied.'), () => {});
    return h('div', { class: 'card', 'data-payout': r.providerId },
      h('div', { class: 'detail-head' },
        h('div', {}, h('strong', {}, r.providerName), h('div', { class: 'muted small' }, `${r.jobs} job(s) · requested ${fmtWhen(r.requestedAt)}`)),
        h('div', { class: 'right' }, h('div', { class: 'amt' }, money(r.totalCents)))),
      r.refundedJobs ? banner('info', `${r.refundedJobs} of these jobs had a refund. Check the amounts before paying.`) : null,
      r.bank
        ? h('dl', { class: 'facts' },
            h('div', { class: 'row' }, h('dt', {}, 'Bank'), h('dd', {}, r.bank.bankName)),
            h('div', { class: 'row' }, h('dt', {}, 'Name'), h('dd', {}, r.bank.accountName)),
            h('div', { class: 'row' }, h('dt', {}, 'Account'), h('dd', {}, h('code', { class: 'acct' }, r.bank.accountNumber), ' ', navigator.clipboard ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: copy }, 'Copy') : null)))
        : banner('error', 'No bank details on file.'),
      actions);
  };
  return [h('div', { class: 'list' }, requests.map(card))];
}
