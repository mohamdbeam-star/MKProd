// Public supplier page for a share link: /share/<id>#k=<key>. No account needed.
// The server hands over ciphertext; the key in the URL fragment decrypts it here in the browser.
import { useEffect, useState } from 'react';
import { linkKeyFrom, openJson, sealJson } from '../crypto';
import { ApiError, api } from '../sync';

/** What an order looks like to a supplier: no budgets, approvers or internal notes. */
export interface OrderSnapshot {
  kind: 'order';
  company: string;
  contactName: string;
  contactEmail: string;
  message: string;
  order: {
    number: number; title: string; poNumber: string; status: string; date: string; currency: string
    supplier: string; expectedDelivery?: string; items: { name: string; qty: number; unitPrice: number }[]; terms: string
  };
}

export interface ShareReply { decision: 'confirm' | 'decline' | 'question'; name: string; email: string; note: string; deliveryDate?: string; at: string }

export function SharePage() {
  const id = location.pathname.split('/')[2]?.toUpperCase() ?? '';
  const fragment = new URLSearchParams(location.hash.slice(1)).get('k') ?? '';
  const [snap, setSnap] = useState<OrderSnapshot | null>(null);
  const [meta, setMeta] = useState<{ allowReply: boolean; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const [reply, setReply] = useState<ShareReply>({ decision: 'confirm', name: '', email: '', note: '', at: '' });
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        if (!id || !fragment) throw new Error('This link is incomplete. Ask for it to be sent again.');
        const r = await api<{ kind: string; blob: string; allowReply: boolean; expiresAt: string }>(`/api/share/${id}`);
        const key = await linkKeyFrom(fragment);
        setSnap(await openJson<OrderSnapshot>(key, r.blob, `share|${id}`));
        setMeta({ allowReply: r.allowReply, expiresAt: r.expiresAt });
      } catch (e) {
        setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not open this link.');
      }
    })();
  }, []);

  const send = async () => {
    setBusy(true);
    try {
      const key = await linkKeyFrom(fragment);
      const blob = await sealJson(key, { ...reply, at: new Date().toISOString() }, `share-reply|${id}`);
      await api(`/api/share/${id}/reply`, { body: { blob } });
      setSent(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const money = (v: number) => `${snap?.order.currency ?? ''} ${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const total = snap?.order.items.reduce((a, i) => a + i.qty * i.unitPrice, 0) ?? 0;

  return (
    <div className="share">
      <div className="card col" style={{ maxWidth: 760, margin: '24px auto' }}>
        <div className="row"><div className="logo">MK</div><div className="grow"><h2>{snap ? `Purchase order #${snap.order.number}` : 'Shared document'}</h2>
          {snap && <div className="small muted">From {snap.company} · {snap.contactName}{snap.contactEmail ? ` · ${snap.contactEmail}` : ''}</div>}</div>
          <button className="btn no-print" onClick={() => window.print()}>🖨 Print</button></div>
        {error && <div className="red">{error}</div>}
        {!snap && !error && <p className="muted">Opening…</p>}
        {snap && (
          <>
            {snap.message && <p style={{ whiteSpace: 'pre-wrap' }}>{snap.message}</p>}
            <div className="props">
              <span className="k">Title</span><span>{snap.order.title}</span>
              {snap.order.poNumber && <><span className="k">PO number</span><span className="mono">{snap.order.poNumber}</span></>}
              <span className="k">Supplier</span><span>{snap.order.supplier || '—'}</span>
              <span className="k">Date</span><span>{new Date(snap.order.date).toLocaleDateString()}</span>
              {snap.order.expectedDelivery && <><span className="k">Delivery by</span><span>{new Date(snap.order.expectedDelivery).toLocaleDateString()}</span></>}
            </div>
            <table className="t"><thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Total</th></tr></thead>
              <tbody>{snap.order.items.map((i, n) => <tr key={n}><td>{i.name}</td><td className="num">{i.qty}</td><td className="num">{money(i.unitPrice)}</td><td className="num">{money(i.qty * i.unitPrice)}</td></tr>)}
                <tr><td colSpan={3} style={{ textAlign: 'right', fontWeight: 700 }}>Total</td><td className="num" style={{ fontWeight: 700 }}>{money(total)}</td></tr></tbody></table>
            {snap.order.terms && <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{snap.order.terms}</p>}
            {meta && <div className="small muted">This link is valid until {new Date(meta.expiresAt).toLocaleDateString()}. It is private to whoever holds it; the content is encrypted and only readable through this link.</div>}
            {meta?.allowReply && !sent && (
              <div className="card col no-print" style={{ background: 'var(--accent-soft)' }}>
                <h3>Your response</h3>
                <div className="seg" style={{ alignSelf: 'flex-start' }}>
                  {([['confirm', '✓ Confirm order'], ['question', '? Question'], ['decline', '✕ Decline']] as const).map(([v, l]) => (
                    <button key={v} type="button" className={reply.decision === v ? 'on' : ''} onClick={() => setReply({ ...reply, decision: v })}>{l}</button>
                  ))}
                </div>
                <div className="grid g2">
                  <label className="field">Your name<input className="input" value={reply.name} onChange={(e) => setReply({ ...reply, name: e.target.value })} /></label>
                  <label className="field">Your email<input className="input" type="email" value={reply.email} onChange={(e) => setReply({ ...reply, email: e.target.value })} /></label>
                  {reply.decision === 'confirm' && <label className="field">Delivery date<input className="input" type="date" value={reply.deliveryDate ?? ''} onChange={(e) => setReply({ ...reply, deliveryDate: e.target.value || undefined })} /></label>}
                </div>
                <label className="field">Message<textarea className="input" rows={3} value={reply.note} onChange={(e) => setReply({ ...reply, note: e.target.value })} placeholder="Lead time, price validity, questions…" /></label>
                <button className="btn primary" disabled={busy || !reply.name.trim()} onClick={send} style={{ alignSelf: 'flex-end' }}>Send response</button>
              </div>
            )}
            {sent && <div className="green">✓ Thank you, your response was sent to {snap.contactName || snap.company}.</div>}
          </>
        )}
        <p className="small faint">Powered by MK Prod · end-to-end encrypted</p>
      </div>
    </div>
  );
}
