// Procurement extras: supplier share links, the printable/Excel order record, approval
// delegation, and encrypted file attachments.
import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { Bytes, linkKeyFrom, newLinkKey, openJson, sealJson } from '../crypto';
import { orderAmount } from '../finance';
import { Attachment, ID, Order, ShareLink, iso, uid } from '../model';
import { api } from '../sync';
import { Avatar, Modal, member, useApp } from '../ui';
import type { OrderSnapshot, ShareReply } from './Share';

// ---------------------------------------------------------------- supplier links

interface ServerShare { id: string; label: string; expires_at: string; views: number; replies: { id: string; blob: string; at: string }[] }

export function SupplierLinks({ order }: { order: Order }) {
  const { engine, fin, toast } = useApp();
  const [links, setLinks] = useState<ServerShare[] | null>(null);
  const [replies, setReplies] = useState<Record<string, ShareReply[]>>({});
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ message: `Please confirm this purchase order and your delivery date.`, terms: '', days: 14, allowReply: true });
  const [made, setMade] = useState<string | null>(null);
  const mine = engine.list('shares').filter((s) => s.refId === order.id);

  const load = async () => {
    try {
      const r = await api<{ shares: ServerShare[] }>(`/api/workspaces/${engine.workspace.id}/shares?ref=${order.id}`);
      setLinks(r.shares);
      const out: Record<string, ShareReply[]> = {};
      for (const s of r.shares) {
        const local = mine.find((m) => m.id === s.id);
        if (!local || !s.replies.length) continue;
        const key = await linkKeyFrom(local.key);
        out[s.id] = [];
        for (const rep of s.replies) {
          try { out[s.id].push(await openJson<ShareReply>(key, rep.blob, `share-reply|${s.id}`)); } catch { /* tampered or foreign: skip */ }
        }
      }
      setReplies(out);
    } catch (e) { toast((e as Error).message); }
  };
  useEffect(() => { load(); }, [order.id, mine.length]);

  const create = async () => {
    try {
      const { key, fragment } = await newLinkKey();
      const id = uid();
      const me = engine.session.user;
      const snap: OrderSnapshot = {
        kind: 'order', company: engine.workspace.name, contactName: me.name, contactEmail: me.email, message: form.message,
        order: {
          number: order.number, title: order.title, poNumber: order.poNumber, status: order.status, date: order.requestedDate, currency: order.currency,
          supplier: order.supplier, expectedDelivery: order.expectedDelivery, items: order.items.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice })), terms: form.terms,
        },
      };
      // The id is part of the ciphertext's AAD, so the client picks it and the server stores it as given.
      const blob = await sealJson(key, snap, `share|${id}`);
      const r = await api<{ id: string; expiresAt: string }>(`/api/workspaces/${engine.workspace.id}/shares`, { body: { kind: 'order', refId: order.id, label: `#${order.number} ${order.title}`.slice(0, 120), blob, allowReply: form.allowReply, days: form.days, id } });
      engine.put('shares', { id: r.id, kind: 'order', refId: order.id, key: fragment, label: `#${order.number}`, createdBy: engine.me, createdAt: iso(), expiresAt: r.expiresAt });
      fin.audit(`Supplier link created for order #${order.number}`, `${form.days} days`);
      setMade(`${location.origin}/share/${r.id}#k=${fragment}`);
      setCreating(false);
      load();
    } catch (e) { toast((e as Error).message); }
  };
  const revoke = async (id: string) => {
    if (!confirm('Revoke this link? The supplier will no longer be able to open it.')) return;
    try { await api(`/api/workspaces/${engine.workspace.id}/shares/${id}`, { method: 'DELETE' }); engine.remove('shares', id); load(); } catch (e) { toast((e as Error).message); }
  };
  const urlFor = (id: string) => { const l = mine.find((m) => m.id === id); return l ? `${location.origin}/share/${id}#k=${l.key}` : null; };

  return (
    <div className="section">
      <div className="row"><h3 className="grow">Supplier links</h3>{engine.canWrite && order.type === 'order' && <button className="btn sm" onClick={() => setCreating(true)}>🔗 Share with supplier</button>}</div>
      <p className="small muted">A read-only page the supplier opens without an account. The content is encrypted with a key that lives only in the link, so only whoever has the link can read it. Suppliers can confirm, decline or ask a question.</p>
      {links?.map((s) => {
        const url = urlFor(s.id);
        const expired = s.expires_at < new Date().toISOString();
        return (
          <div key={s.id} className="card col" style={{ padding: 10, gap: 6 }}>
            <div className="row wrap">
              <span className={expired ? 'muted' : ''}>{expired ? 'Expired' : `Valid until ${new Date(s.expires_at).toLocaleDateString()}`} · opened {s.views}×</span>
              <span className="grow" />
              {url && !expired && <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(url); toast('Link copied'); }}>Copy link</button>}
              {order.supplierEmail && url && !expired && <a className="btn sm" href={`mailto:${order.supplierEmail}?subject=${encodeURIComponent(`Purchase order #${order.number} – ${order.title}`)}&body=${encodeURIComponent(`${form.message}\n\n${url}`)}`}>✉️ Email supplier</a>}
              {engine.canWrite && <button className="btn sm danger" onClick={() => revoke(s.id)}>Revoke</button>}
            </div>
            {(replies[s.id] ?? []).map((r, i) => (
              <div key={i} className="row small" style={{ alignItems: 'flex-start', background: 'var(--hover)', borderRadius: 6, padding: 6 }}>
                <span>{r.decision === 'confirm' ? '✅' : r.decision === 'decline' ? '❌' : '❓'}</span>
                <div className="grow"><strong>{r.name}</strong>{r.email ? ` · ${r.email}` : ''} · {new Date(r.at).toLocaleString()}
                  {r.deliveryDate && <div>Delivery: {new Date(r.deliveryDate).toLocaleDateString()}</div>}
                  {r.note && <div style={{ whiteSpace: 'pre-wrap' }}>{r.note}</div>}</div>
              </div>
            ))}
            {s.replies.length > 0 && !(replies[s.id]?.length) && <div className="small muted">{s.replies.length} reply(ies) you can't decrypt (link created on another device before this one synced).</div>}
          </div>
        );
      })}
      {links && !links.length && <div className="small muted">No links yet.</div>}
      {creating && (
        <Modal title={`Share order #${order.number} with the supplier`} onClose={() => setCreating(false)} footer={<><button className="btn" onClick={() => setCreating(false)}>Cancel</button><button className="btn primary" onClick={create}>Create link</button></>}>
          <p className="small muted">The supplier sees: title, PO number, items, quantities, prices, total and delivery date. Not shown: budgets, approvers, internal notes.</p>
          <label className="field">Message to the supplier<textarea className="input" rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></label>
          <label className="field">Terms (optional)<textarea className="input" rows={2} value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} placeholder="Payment terms, delivery address, reference to contract…" /></label>
          <div className="row wrap">
            <label className="field">Valid for<select className="input" value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })}>{[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
            <label className="row small" style={{ marginTop: 18 }}><input type="checkbox" checked={form.allowReply} onChange={(e) => setForm({ ...form, allowReply: e.target.checked })} /> Supplier can respond</label>
          </div>
        </Modal>
      )}
      {made && (
        <Modal title="Supplier link ready" onClose={() => setMade(null)} footer={<><button className="btn" onClick={() => { navigator.clipboard?.writeText(made); toast('Link copied'); }}>Copy</button><button className="btn primary" onClick={() => setMade(null)}>Done</button></>}>
          <div className="mono small" style={{ wordBreak: 'break-all', userSelect: 'all', background: 'var(--hover)', padding: 10, borderRadius: 8 }}>{made}</div>
          <p className="small muted">Send it to the supplier by email or chat. Anyone with the link can read the order, so send it only to them. You can revoke it any time.</p>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- order record (audit-grade)

export function orderRecordRows(engine: ReturnType<typeof useApp>['engine'], fin: ReturnType<typeof useApp>['fin'], o: Order) {
  const name = (id?: ID) => member(engine, id)?.name ?? '';
  const b = fin.budget(o.budgetId);
  const header = [
    { Field: 'Order number', Value: `#${o.number}` }, { Field: 'Type', Value: o.type === 'order' ? 'Purchase order' : 'Direct expense' }, { Field: 'Title', Value: o.title },
    { Field: 'Entity', Value: fin.entity(o.entityId)?.name ?? '' }, { Field: 'Budget line', Value: b ? `${b.category} ${b.year} › ${fin.line(o.budgetId, o.lineItemId)?.name ?? ''}` : 'Unbudgeted' },
    { Field: 'Supplier', Value: [o.supplier, o.supplierEmail].filter(Boolean).join(' · ') }, { Field: 'PO number', Value: o.poNumber }, { Field: 'LPO / invoice', Value: o.lpo },
    { Field: 'Amount', Value: `${o.currency} ${orderAmount(o).toLocaleString()}` }, { Field: 'Status', Value: o.status },
    { Field: 'Requested by', Value: `${name(o.requestedBy)} on ${new Date(o.requestedDate).toLocaleString()}` },
    { Field: 'Final approval', Value: o.approvedBy ? `${name(o.approvedBy)} on ${new Date(o.approvedDate!).toLocaleString()}` : '' },
    { Field: 'Delivered', Value: o.actualDelivery ? new Date(o.actualDelivery).toLocaleString() : '' }, { Field: 'Notes', Value: o.notes },
  ];
  const items = o.items.map((i) => ({ Item: i.name, Qty: i.qty, 'Unit price': i.unitPrice, Total: i.qty * i.unitPrice }));
  const trail = o.history.map((h) => ({ When: new Date(h.date).toLocaleString(), Who: name(h.memberId), Action: h.action, From: h.from, To: h.to, Note: h.note }));
  return { header, items, trail };
}

export function exportOrderRecord(engine: ReturnType<typeof useApp>['engine'], fin: ReturnType<typeof useApp>['fin'], o: Order) {
  const { header, items, trail } = orderRecordRows(engine, fin, o);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(header), 'Order');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(items), 'Items');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trail), 'Approval trail');
  XLSX.writeFile(wb, `order-${o.number}-record.xlsx`);
}

/** Rendered only when printing (body.print-record): the complete order with its approval trail. */
export function OrderRecordPrint({ order: o }: { order: Order }) {
  const { engine, fin } = useApp();
  const { header, items, trail } = orderRecordRows(engine, fin, o);
  return (
    <div className="record">
      <h1>{engine.workspace.name} · Order record #{o.number}</h1>
      <div style={{ marginBottom: 12 }}>Generated {new Date().toLocaleString()} by {member(engine, engine.me)?.name}. End-to-end encrypted workspace; this record was decrypted on the device that printed it.</div>
      <table><tbody>{header.filter((h) => h.Value).map((h) => <tr key={h.Field}><th style={{ width: 160 }}>{h.Field}</th><td>{h.Value}</td></tr>)}</tbody></table>
      <h2 style={{ marginTop: 16 }}>Items</h2>
      <table><thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Total</th></tr></thead>
        <tbody>{items.map((i, n) => <tr key={n}><td>{i.Item}</td><td className="num">{i.Qty}</td><td className="num">{i['Unit price'].toLocaleString()}</td><td className="num">{i.Total.toLocaleString()}</td></tr>)}</tbody></table>
      <h2 style={{ marginTop: 16 }}>Approval trail</h2>
      <table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>From</th><th>To</th><th>Note</th></tr></thead>
        <tbody>{trail.map((t, n) => <tr key={n}><td>{t.When}</td><td>{t.Who}</td><td>{t.Action}</td><td>{t.From}</td><td>{t.To}</td><td>{t.Note}</td></tr>)}</tbody></table>
    </div>
  );
}

export function printRecord() {
  document.body.classList.add('print-record');
  const done = () => { document.body.classList.remove('print-record'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}

// ---------------------------------------------------------------- approval delegation

export function DelegationsCard() {
  const { engine, fin, toast } = useApp();
  const [form, setForm] = useState({ from: engine.me, to: '', until: '', note: '' });
  const all = [...(fin.settings.delegations ?? [])].sort((a, b) => a.until.localeCompare(b.until));
  const active = new Set(fin.activeDelegations().map((d) => d.id));
  const canEdit = (from: ID) => engine.canWrite && (from === engine.me || fin.isAdmin);
  return (
    <div className="card col">
      <h2>Approval delegation (out of office)</h2>
      <p className="small muted">While a delegation is active, the delegate can approve or reject whatever the delegator could, and the approval trail records "on behalf of". You can delegate your own approvals; admins can set delegations for anyone.</p>
      {all.length > 0 && (
        <table className="t"><thead><tr><th>From</th><th>To</th><th>Until</th><th>Note</th><th /></tr></thead><tbody>
          {all.map((d) => (
            <tr key={d.id} style={{ opacity: active.has(d.id) ? 1 : 0.5 }}>
              <td><span className="row"><Avatar m={member(engine, d.from)} size={18} />{member(engine, d.from)?.name}</span></td>
              <td><span className="row"><Avatar m={member(engine, d.to)} size={18} />{member(engine, d.to)?.name}</span></td>
              <td>{new Date(d.until).toLocaleDateString()}{!active.has(d.id) && <span className="small muted"> (ended)</span>}</td>
              <td className="muted">{d.note}</td>
              <td className="num">{canEdit(d.from) && <button className="btn sm" onClick={() => fin.removeDelegation(d.id)}>End</button>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      {engine.canWrite && (
        <div className="row wrap">
          <select className="input" value={form.from} disabled={!fin.isAdmin} onChange={(e) => setForm({ ...form, from: e.target.value })}>{engine.members.map((m) => <option key={m.id} value={m.id}>{m.id === engine.me ? 'Me' : m.name}</option>)}</select>
          <span>→</span>
          <select className="input" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}><option value="">Delegate to…</option>{engine.members.filter((m) => m.id !== form.from).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          <input className="input" type="date" value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} />
          <input className="input grow" placeholder="Note (e.g. annual leave)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <button className="btn primary" disabled={!form.to || !form.until} onClick={() => {
            fin.addDelegation(form.from, form.to, iso(new Date(form.until + 'T23:59:59')), form.note);
            toast('Delegation added');
            setForm({ from: engine.me, to: '', until: '', note: '' });
          }}>Delegate</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- encrypted attachments

const MAX_ATTACH = 25 * 1024 * 1024;
const fmtSize = (n?: number) => (n === undefined ? '' : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function Attachments({ items, onChange }: { items: Attachment[]; onChange: (fn: (a: Attachment[]) => void) => void }) {
  const { engine, toast } = useApp();
  const [busy, setBusy] = useState('');
  const [link, setLink] = useState('');
  const [filesEnabled, setFilesEnabled] = useState(true);
  useEffect(() => { api<{ filesEnabled: boolean }>('/api/me').then((r) => setFilesEnabled(r.filesEnabled)).catch(() => {}); }, []);

  const upload = async (file: File) => {
    if (file.size > MAX_ATTACH) { toast('Files up to 25 MB can be attached'); return; }
    setBusy(`Encrypting and uploading ${file.name}…`);
    try {
      const { fileId, size } = await engine.uploadFile(new Uint8Array(await file.arrayBuffer()) as Bytes);
      onChange((a) => { a.push({ id: uid(), name: file.name, path: '', added: iso(), fileId, size, mime: file.type || 'application/octet-stream' }); });
      toast('Attached');
    } catch (e) { toast((e as Error).message); } finally { setBusy(''); }
  };
  const download = async (a: Attachment) => {
    setBusy(`Downloading ${a.name}…`);
    try {
      const bytes = await engine.downloadFile(a.fileId!);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: a.mime || 'application/octet-stream' }));
      const el = document.createElement('a'); el.href = url; el.download = a.name; el.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { toast((e as Error).message); } finally { setBusy(''); }
  };
  const remove = async (a: Attachment) => {
    if (!confirm(`Remove ${a.name}?`)) return;
    try {
      if (a.fileId) await engine.deleteFile(a.fileId).catch(() => {});
      onChange((arr) => { const i = arr.findIndex((x) => x.id === a.id); if (i >= 0) arr.splice(i, 1); });
    } catch (e) { toast((e as Error).message); }
  };
  return (
    <div className="section">
      <div className="row"><h3 className="grow">Attachments {items.length > 0 && <span className="muted small">{items.length}</span>}</h3>
        {engine.canWrite && filesEnabled && engine.encrypted && <label className="btn sm">⬆ Upload file<input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} /></label>}</div>
      {!filesEnabled && <div className="small muted">File storage isn't set up on the server yet (see CLOUD_SETUP.md); links still work.</div>}
      {items.map((a) => (
        <div key={a.id} className="row" style={{ padding: '3px 0' }}>
          <span>{a.fileId ? '📎' : '🔗'}</span>
          {a.fileId
            ? <a href="#" className="grow ellipsis" onClick={(e) => { e.preventDefault(); download(a); }}>{a.name}</a>
            : <a className="grow ellipsis" href={a.path} target="_blank" rel="noopener noreferrer">{a.name || a.path}</a>}
          <span className="small muted">{fmtSize(a.size)}{a.fileId ? ' · encrypted' : ''}</span>
          {engine.canWrite && <button className="btn sm ghost" onClick={() => remove(a)}>✕</button>}
        </div>
      ))}
      {engine.canWrite && (
        <div className="row"><input className="input grow" placeholder="Or paste a link (SharePoint, Drive…) + Enter" value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter' && /^https?:\/\//.test(link.trim())) { const u = link.trim(); onChange((a) => { a.push({ id: uid(), name: u.replace(/^https?:\/\//, '').slice(0, 60), path: u, added: iso() }); }); setLink(''); }
        }} /></div>
      )}
      {busy && <div className="small muted">{busy}</div>}
    </div>
  );
}
