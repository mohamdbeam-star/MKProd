import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Budget, CatalogItem, Contract, ID, Order, Saving, iso, newOrderDraft, toInputDate, fromInputDate, uid, addDays } from '../model';
import { Avatar, CHART_COLORS, ChartBox, Empty, KPI, Modal, Pill, UtilBar, member, useApp } from '../ui';
import { Figures, S, add, balance, isOutgoing, isPending, orderAmount, utilization, zero } from '../finance';
import { DelegationsCard, OrderRecordPrint, SupplierLinks, exportOrderRecord, printRecord } from './Procurement';

const year = new Date().getFullYear();

function statusColor(s: string) {
  if (isPending(s)) return '#E8912D';
  return ({ Approved: '#3E7BE8', Recorded: '#3E7BE8', Ordered: '#8E5CF7', Shipped: '#12B5CB', Delivered: '#2FA86C', Completed: '#2FA86C', Rejected: '#E5484D', Cancelled: '#E5484D', Active: '#2FA86C', Expiring: '#E8912D', Expired: '#E5484D', Renewing: '#3E7BE8', Upcoming: '#87909E', Terminated: '#87909E' } as Record<string, string>)[s] ?? '#87909E';
}

function Filters({ y, setY, e, setE, allYears = true }: { y: number | ''; setY: (v: number | '') => void; e: string; setE: (v: string) => void; allYears?: boolean }) {
  const { engine, fin } = useApp();
  return (
    <>
      <select className="input" value={y} onChange={(ev) => setY(ev.target.value ? Number(ev.target.value) : '')}>
        {allYears && <option value="">All years</option>}
        {[...fin.settings.years].sort((a, b) => b - a).map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      <select className="input" value={e} onChange={(ev) => setE(ev.target.value)}>
        <option value="">All entities</option>
        {engine.list('entities').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </>
  );
}

function download(name: string, rows: Record<string, unknown>[], sheet = 'Data') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet);
  XLSX.writeFile(wb, name);
}

// ---------------------------------------------------------------- Overview

export function FinanceOverview() {
  const { engine, fin, go } = useApp();
  const [y, setY] = useState<number | ''>(year);
  const [e, setE] = useState('');
  const budgets = engine.list('budgets').filter((b) => (!y || b.year === y) && (!e || b.entityId === e));
  const total = budgets.map((b) => fin.budgetFigures(b)).reduce(add, zero());
  const orders = engine.list('orders').filter((o) => (!e || o.entityId === e) && (!y || new Date(o.requestedDate).getFullYear() === y));
  const savings = engine.list('savings').filter((s) => (!e || s.entityId === e) && (!y || new Date(s.date).getFullYear() === y));
  const byEntity = engine.list('entities').map((en) => ({ name: en.name, f: budgets.filter((b) => b.entityId === en.id).map((b) => fin.budgetFigures(b)).reduce(add, zero()) })).filter((x) => x.f.allocated > 0);
  const cats = Object.entries(budgets.reduce<Record<string, Figures>>((a, b) => { a[b.category] = add(a[b.category] ?? zero(), fin.budgetFigures(b)); return a; }, {}));
  const months = Array.from({ length: 12 }, (_, i) => orders.filter((o) => isOutgoing(o) && new Date(o.requestedDate).getMonth() === i).reduce((a, o) => a + orderAmount(o), 0));
  const suppliers = Object.entries(orders.filter((o) => isOutgoing(o) && o.supplier).reduce<Record<string, number>>((a, o) => { a[o.supplier] = (a[o.supplier] ?? 0) + orderAmount(o); return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="toolbar"><h1 className="grow">Finance overview</h1><Filters y={y} setY={setY} e={e} setE={setE} /><button className="btn no-print" onClick={() => window.print()}>🖨 Print / PDF</button></div>
      <div className="grid g4">
        <KPI label="Total budget" value={fin.money(total.allocated)} icon="💰" color="#7B68EE" />
        <KPI label="Spent" value={fin.money(total.spent)} icon="✓" color="#2FA86C" />
        <KPI label="Committed" value={fin.money(total.committed)} icon="🔒" color="#3E7BE8" />
        <KPI label="Remaining" value={fin.money(balance(total))} icon="⚖" color={balance(total) < 0 ? '#E5484D' : '#12B5CB'} />
        <KPI label="Utilization" value={`${Math.round(utilization(total) * 100)}%`} icon="◔" color="#8E5CF7" />
        <KPI label="Pending approvals" value={orders.filter((o) => isPending(o.status)).length} icon="⏳" color="#E8912D" />
        <KPI label="Savings" value={fin.money(savings.reduce((a, s) => a + s.amount, 0))} icon="💵" color="#2FA86C" />
        <KPI label="Unbudgeted spend" value={fin.money(orders.filter((o) => o.isUnbudgeted && isOutgoing(o)).reduce((a, o) => a + orderAmount(o), 0))} icon="⚠" color="#E5484D" />
      </div>
      <div className="grid g2">
        <div className="card"><h3>Budget vs spent by entity</h3>
          <ChartBox config={{ type: 'bar', data: { labels: byEntity.map((x) => x.name), datasets: [
            { label: 'Budget', data: byEntity.map((x) => x.f.allocated), backgroundColor: '#7B68EE55' },
            { label: 'Spent', data: byEntity.map((x) => x.f.spent), backgroundColor: '#2FA86C' },
            { label: 'Committed', data: byEntity.map((x) => x.f.committed), backgroundColor: '#3E7BE8' }] } }} /></div>
        <div className="card"><h3>Spend by category</h3>
          <ChartBox config={{ type: 'doughnut', data: { labels: cats.map((c) => c[0]), datasets: [{ data: cats.map((c) => c[1].spent + c[1].committed), backgroundColor: CHART_COLORS }] } }} /></div>
        <div className="card"><h3>Monthly spend</h3>
          <ChartBox config={{ type: 'bar', data: { labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], datasets: [{ label: 'Spend', data: months, backgroundColor: '#7B68EE' }] } }} /></div>
        <div className="card"><h3>Top suppliers</h3>
          <ChartBox config={{ type: 'bar', data: { labels: suppliers.map((s) => s[0]), datasets: [{ label: 'Spend', data: suppliers.map((s) => s[1]), backgroundColor: '#8E5CF7' }] }, options: { indexAxis: 'y' } }} /></div>
      </div>
      <div className="card"><h3>Alerts</h3><AlertList limit={8} onGo={go} /></div>
    </div>
  );
}

function AlertList({ limit, onGo }: { limit?: number; onGo: (r: string) => void }) {
  const { fin } = useApp();
  const alerts = fin.alerts().slice(0, limit);
  if (!alerts.length) return <p className="muted">No alerts 🎉</p>;
  return (
    <div>{alerts.map((a, i) => (
      <div key={i} className="row" style={{ padding: '6px 0', cursor: 'pointer', borderBottom: '1px solid var(--line)' }} onClick={() => onGo(a.page)}>
        <span>{a.severity === 2 ? '⛔' : a.severity === 1 ? '⚠️' : 'ℹ️'}</span>
        <div className="grow"><div style={{ fontWeight: 600 }}>{a.title}</div>{a.detail && <div className="small muted">{a.detail}</div>}</div>
      </div>
    ))}</div>
  );
}

export function AlertsPage() {
  const { go } = useApp();
  return <div className="card"><h2>Alerts</h2><AlertList onGo={go} /></div>;
}

// ---------------------------------------------------------------- Budgets

export function BudgetsPage() {
  const { engine, fin, toast } = useApp();
  const [y, setY] = useState<number | ''>(year);
  const [e, setE] = useState('');
  const [editing, setEditing] = useState<Budget | null>(null);
  const [ordering, setOrdering] = useState<Order | null>(null);
  const entities = engine.list('entities');
  const budgets = engine.list('budgets').filter((b) => (!y || b.year === y) && (!e || b.entityId === e))
    .sort((a, b) => (fin.entity(a.entityId)?.name ?? '').localeCompare(fin.entity(b.entityId)?.name ?? '') || a.category.localeCompare(b.category));
  const total = budgets.map((b) => fin.budgetFigures(b)).reduce(add, zero());

  const importFile = async (file: File) => {
    const wb = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(wb.Sheets[wb.SheetNames[0]]);
    let n = 0;
    const ents = [...engine.list('entities')];
    const budgets = engine.list('budgets').map((b) => structuredClone(b));
    for (const r of rows) {
      const name = String(r.Entity ?? '').trim(), yr = Number(r.Year), cat = String(r.Category ?? '').trim(), amount = Number(String(r.Allocated ?? '').replace(/,/g, ''));
      if (!name || !yr || !cat || !amount) continue;
      let en = ents.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!en) { en = { id: uid(), name, code: '', approvalLevels: ['Requestor', 'Manager'], roles: [] }; ents.push(en); engine.put('entities', en); }
      const line = { id: uid(), name: String(r['Line Item'] ?? 'General'), allocated: amount, notes: String(r.Notes ?? '') };
      let b = budgets.find((x) => x.entityId === en!.id && x.year === yr && x.category === cat);
      if (b) b.lineItems.push(line); else { b = { id: uid(), entityId: en.id, year: yr, category: cat, notes: '', lineItems: [line], created: iso() }; budgets.push(b); }
      engine.put('budgets', b);
      fin.saveSettings((s) => { if (!s.years.includes(yr)) s.years.push(yr); if (!s.categories.includes(cat)) s.categories.push(cat); });
      n++;
    }
    fin.audit('Imported budgets', `${n} line items`);
    toast(`Imported ${n} budget line(s)`);
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="toolbar">
        <h1 className="grow">Budgets</h1>
        <Filters y={y} setY={setY} e={e} setE={setE} />
        <button className="btn" onClick={() => download('budget-template.xlsx', [{ Entity: 'Finance Dept', Year: year, Category: 'IT', 'Line Item': 'Laptops', Allocated: 50000, Notes: '' }], 'Budgets')}>⬇ Template</button>
        <label className="btn">⬆ Import Excel<input type="file" accept=".xlsx,.xls,.csv" hidden onChange={(ev) => ev.target.files?.[0] && importFile(ev.target.files[0])} /></label>
        <button className="btn primary" disabled={!fin.isAdmin || !entities.length} onClick={() => setEditing({ id: uid(), entityId: e || entities[0].id, year: y || year, category: fin.settings.categories[0] ?? 'General', notes: '', lineItems: [{ id: uid(), name: 'General', allocated: 0, notes: '' }], created: iso() })}>+ New budget</button>
      </div>
      <div className="grid g4">
        <KPI label="Allocated" value={fin.money(total.allocated)} icon="💰" color="#7B68EE" />
        <KPI label="Spent" value={fin.money(total.spent)} icon="✓" color="#2FA86C" />
        <KPI label="Committed" value={fin.money(total.committed)} icon="🔒" color="#3E7BE8" />
        <KPI label="Balance" value={fin.money(balance(total))} icon="⚖" color={balance(total) < 0 ? '#E5484D' : '#12B5CB'} />
      </div>
      {!entities.length && <Empty icon="🏢" title="Add an entity first" sub="Budgets belong to entities (departments, schools, units). Add them in Finance settings." />}
      {entities.length > 0 && !budgets.length && <Empty icon="💰" title="No budgets for this filter" />}
      {budgets.map((b) => {
        const f = fin.budgetFigures(b);
        return (
          <div key={b.id} className="card col">
            <div className="row">
              <div className="grow"><h3>{b.category} · {b.year}</h3><div className="small muted">{fin.entity(b.entityId)?.name}</div></div>
              <div style={{ textAlign: 'right' }}><strong className={balance(f) < 0 ? 'red' : ''}>{fin.money(balance(f))}</strong><div className="small muted">left of {fin.money(f.allocated)}</div></div>
              {fin.isAdmin && <button className="btn" onClick={() => setEditing(structuredClone(b))}>Edit</button>}
            </div>
            <UtilBar {...f} />
            <table className="t">
              <thead><tr><th>Line item</th><th className="num">Allocated</th><th className="num">Spent</th><th className="num">Committed</th><th className="num">Pending</th><th className="num">Balance</th><th className="num">Used</th><th /></tr></thead>
              <tbody>{b.lineItems.map((l) => {
                const lf = fin.figures(b.id, l.id);
                const u = utilization(lf);
                return (
                  <tr key={l.id}><td>{l.name}</td><td className="num">{fin.money(lf.allocated)}</td><td className="num">{fin.money(lf.spent)}</td><td className="num">{fin.money(lf.committed)}</td>
                    <td className="num orange">{fin.money(lf.pending)}</td><td className={`num ${balance(lf) < 0 ? 'red' : ''}`}>{fin.money(balance(lf))}</td>
                    <td className={`num ${u > 1 ? 'red' : u > 0.9 ? 'orange' : 'muted'}`}>{Math.round(u * 100)}%</td>
                    <td className="num"><button className="btn sm" onClick={() => setOrdering({ ...newOrderDraft(b.entityId, engine.me), budgetId: b.id, lineItemId: l.id })}>Order</button></td></tr>
                );
              })}</tbody>
            </table>
          </div>
        );
      })}
      {editing && <BudgetEditor budget={editing} onClose={() => setEditing(null)} />}
      {ordering && <OrderEditor draft={ordering} onClose={() => setOrdering(null)} />}
    </div>
  );
}

function BudgetEditor({ budget, onClose }: { budget: Budget; onClose: () => void }) {
  const { engine, fin } = useApp();
  const [b, setB] = useState(budget);
  const exists = !!engine.get('budgets', b.id);
  const total = b.lineItems.reduce((a, l) => a + (Number(l.allocated) || 0), 0);
  return (
    <Modal title={exists ? 'Edit budget' : 'New budget'} onClose={onClose} footer={<>
      {exists && <button className="btn danger" onClick={() => { engine.remove('budgets', b.id); fin.audit('Deleted budget', `${b.category} ${b.year}`); onClose(); }}>Delete</button>}
      <span className="grow" />
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={() => { engine.put('budgets', b); fin.audit(exists ? 'Updated budget' : 'Created budget', `${b.category} ${b.year} · ${fin.money(total)}`); onClose(); }}>Save</button>
    </>}>
      <div className="grid g3">
        <label className="field">Entity<select className="input" value={b.entityId} onChange={(e) => setB({ ...b, entityId: e.target.value })}>{engine.list('entities').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className="field">Year<select className="input" value={b.year} onChange={(e) => setB({ ...b, year: Number(e.target.value) })}>{fin.settings.years.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field">Category<select className="input" value={b.category} onChange={(e) => setB({ ...b, category: e.target.value })}>{fin.settings.categories.map((x) => <option key={x}>{x}</option>)}</select></label>
      </div>
      <label className="field">Notes<input className="input" value={b.notes} onChange={(e) => setB({ ...b, notes: e.target.value })} /></label>
      <h3>Line items · {fin.money(total)}</h3>
      {b.lineItems.map((l, i) => (
        <div key={l.id} className="row">
          <input className="input grow" value={l.name} onChange={(e) => { const x = structuredClone(b); x.lineItems[i].name = e.target.value; setB(x); }} />
          <input className="input" type="number" style={{ width: 140 }} value={l.allocated} onChange={(e) => { const x = structuredClone(b); x.lineItems[i].allocated = Number(e.target.value); setB(x); }} />
          <button className="btn ghost" onClick={() => setB({ ...b, lineItems: b.lineItems.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <button className="btn" onClick={() => setB({ ...b, lineItems: [...b.lineItems, { id: uid(), name: 'New line', allocated: 0, notes: '' }] })}>+ Line item</button>
    </Modal>
  );
}

// ---------------------------------------------------------------- Orders

export function OrdersPage({ approvalsOnly, openId }: { approvalsOnly?: boolean; openId?: ID }) {
  const { engine, fin, go } = useApp();
  const [y, setY] = useState<number | ''>('');
  const [e, setE] = useState('');
  const [scope, setScope] = useState('all');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Order | null>(null);
  const me = engine.me;
  const orders = engine.list('orders').filter((o) => {
    if (approvalsOnly) return fin.canApprove(o);
    if (e && o.entityId !== e) return false;
    if (y && new Date(o.requestedDate).getFullYear() !== y) return false;
    if (q && !`${o.title} ${o.supplier} ${o.poNumber} ${o.lpo} #${o.number}`.toLowerCase().includes(q.toLowerCase())) return false;
    switch (scope) {
      case 'pending': return isPending(o.status);
      case 'active': return [S.approved, S.ordered, S.shipped].includes(o.status);
      case 'done': return [S.delivered, S.completed, S.recorded].includes(o.status);
      case 'rejected': return [S.rejected, S.cancelled].includes(o.status);
      case 'mine': return o.requestedBy === me;
      case 'assigned': return o.assignedTo === me;
      default: return true;
    }
  }).sort((a, b) => b.requestedDate.localeCompare(a.requestedDate));
  const entities = engine.list('entities');
  const exportRows = () => orders.map((o) => ({
    Number: o.number, Type: o.type, Title: o.title, Entity: fin.entity(o.entityId)?.name ?? '', Budget: fin.budget(o.budgetId) ? `${fin.budget(o.budgetId)!.category} ${fin.budget(o.budgetId)!.year}` : 'Unbudgeted',
    Line: fin.line(o.budgetId, o.lineItemId)?.name ?? '', Supplier: o.supplier, Amount: orderAmount(o), Currency: o.currency, Status: o.status,
    'Requested by': member(engine, o.requestedBy)?.name ?? '', Requested: o.requestedDate.slice(0, 10), PO: o.poNumber, LPO: o.lpo,
  }));
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="toolbar">
        <h1 className="grow">{approvalsOnly ? 'My approvals' : 'Orders & expenses'}</h1>
        {!approvalsOnly && <>
          <Filters y={y} setY={setY} e={e} setE={setE} />
          <select className="input" value={scope} onChange={(ev) => setScope(ev.target.value)}>
            {[['all', 'All'], ['pending', 'Pending'], ['active', 'In progress'], ['done', 'Done'], ['rejected', 'Rejected'], ['mine', 'Requested by me'], ['assigned', 'Assigned to me']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input className="input" placeholder="Search…" value={q} onChange={(ev) => setQ(ev.target.value)} style={{ width: 160 }} />
          <button className="btn" onClick={() => download('orders.xlsx', exportRows(), 'Orders')}>⬇ Excel</button>
          <button className="btn" disabled={!entities.length} onClick={() => setDraft(newOrderDraft(e || entities[0].id, me, 'expense'))}>+ Expense</button>
          <button className="btn primary" disabled={!entities.length} onClick={() => setDraft(newOrderDraft(e || entities[0].id, me))}>+ Purchase order</button>
        </>}
      </div>
      {orders.length === 0 ? <Empty icon={approvalsOnly ? '✅' : '📦'} title={approvalsOnly ? 'Nothing to approve' : 'No orders'} /> : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table className="t">
            <thead><tr><th>#</th><th>Title</th><th>Entity</th><th>Supplier</th><th className="num">Amount</th><th>Status</th><th>Requested</th></tr></thead>
            <tbody>{orders.map((o) => (
              <tr key={o.id} className="click" onClick={() => go(`${approvalsOnly ? 'approvals' : 'orders'}/${o.id}`)}>
                <td className="muted mono">{o.number}</td>
                <td>{o.type === 'order' ? '📦' : '💳'} {o.title} {o.isUnbudgeted && <span className="small red">Unbudgeted</span>}</td>
                <td>{fin.entity(o.entityId)?.name}</td><td>{o.supplier}</td><td className="num">{fin.money(orderAmount(o))}</td>
                <td><Pill text={o.status} color={statusColor(o.status)} /></td>
                <td><span className="row"><Avatar m={member(engine, o.requestedBy)} size={18} />{new Date(o.requestedDate).toLocaleDateString()}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {draft && <OrderEditor draft={draft} onClose={() => setDraft(null)} />}
      {openId && engine.get('orders', openId) && <OrderDetail id={openId} onClose={() => go(approvalsOnly ? 'approvals' : 'orders')} />}
    </div>
  );
}

export function OrderEditor({ draft, onClose }: { draft: Order; onClose: () => void }) {
  const { engine, fin } = useApp();
  const [o, setO] = useState(draft);
  const set = (p: Partial<Order>) => setO({ ...o, ...p });
  const budgets = engine.list('budgets').filter((b) => b.entityId === o.entityId).sort((a, b) => b.year - a.year);
  const lineF = o.budgetId && o.lineItemId ? fin.figures(o.budgetId, o.lineItemId) : null;
  const amount = orderAmount(o);
  const valid = o.title.trim() && o.items.some((i) => i.name.trim()) && (!o.budgetId || o.lineItemId);
  return (
    <Modal wide title={o.type === 'order' ? 'New purchase order' : 'New direct expense'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!valid} onClick={() => { fin.createOrder(o); onClose(); }}>{o.type === 'order' ? 'Submit for approval' : 'Record expense'}</button>
    </>}>
      <div className="grid g3">
        <label className="field">Title *<input className="input" value={o.title} onChange={(e) => set({ title: e.target.value })} autoFocus /></label>
        <label className="field">Entity<select className="input" value={o.entityId} onChange={(e) => set({ entityId: e.target.value, budgetId: undefined, lineItemId: undefined })}>{engine.list('entities').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className="field">Type<select className="input" value={o.type} onChange={(e) => set({ type: e.target.value as 'order' | 'expense' })}><option value="order">Purchase order</option><option value="expense">Direct expense</option></select></label>
        <label className="field">Budget<select className="input" value={o.budgetId ?? ''} onChange={(e) => set({ budgetId: e.target.value || undefined, lineItemId: undefined })}>
          <option value="">Unbudgeted</option>{budgets.map((b) => <option key={b.id} value={b.id}>{b.category} {b.year}</option>)}</select></label>
        {o.budgetId && <label className="field">Line item<select className="input" value={o.lineItemId ?? ''} onChange={(e) => set({ lineItemId: e.target.value || undefined })}>
          <option value="">Choose…</option>{fin.budget(o.budgetId)?.lineItems.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
        <label className="field">Supplier<input className="input" value={o.supplier} onChange={(e) => set({ supplier: e.target.value })} /></label>
        <label className="field">Supplier email<input className="input" value={o.supplierEmail} onChange={(e) => set({ supplierEmail: e.target.value })} /></label>
        <label className="field">Item category<select className="input" value={o.itemCategory} onChange={(e) => set({ itemCategory: e.target.value })}><option value="">—</option>{fin.settings.itemCategories.map((x) => <option key={x}>{x}</option>)}</select></label>
        {o.type === 'expense'
          ? <label className="field">LPO / invoice #<input className="input" value={o.lpo} onChange={(e) => set({ lpo: e.target.value })} /></label>
          : <label className="field">Expected delivery<input className="input" type="date" value={toInputDate(o.expectedDelivery)} onChange={(e) => set({ expectedDelivery: fromInputDate(e.target.value) })} /></label>}
      </div>
      {lineF ? <div className={amount > balance(lineF) - lineF.pending ? 'red' : 'green'}>Remaining on this line: {fin.money(balance(lineF) - lineF.pending)}</div>
        : <div className="orange small">⚠ Unbudgeted spend needs an extra admin approval.</div>}
      <h3>Items · {fin.money(amount)}</h3>
      {o.items.map((it, i) => (
        <div key={it.id} className="row">
          <input className="input grow" placeholder="Item" value={it.name} onChange={(e) => { const x = structuredClone(o); x.items[i].name = e.target.value; setO(x); }} />
          <input className="input" type="number" style={{ width: 80 }} value={it.qty} onChange={(e) => { const x = structuredClone(o); x.items[i].qty = Number(e.target.value); setO(x); }} />
          <input className="input" type="number" style={{ width: 120 }} value={it.unitPrice} onChange={(e) => { const x = structuredClone(o); x.items[i].unitPrice = Number(e.target.value); setO(x); }} />
          <span className="mono" style={{ width: 120, textAlign: 'right' }}>{fin.money(it.qty * it.unitPrice)}</span>
          <button className="btn ghost" onClick={() => set({ items: o.items.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <div className="row">
        <button className="btn" onClick={() => set({ items: [...o.items, { id: uid(), name: '', qty: 1, unitPrice: 0 }] })}>+ Item</button>
        <select className="input" value="" onChange={(e) => {
          const c = engine.get('catalog', e.target.value);
          if (c) setO({ ...o, supplier: o.supplier || c.supplier, items: [...o.items.filter((i) => i.name.trim()), { id: uid(), name: c.name, qty: 1, unitPrice: c.unitPrice, catalogItemId: c.id }] });
        }}><option value="">+ From catalog…</option>{engine.list('catalog').filter((c) => c.status === 'approved').map((c) => <option key={c.id} value={c.id}>{c.name} · {fin.money(c.unitPrice)}</option>)}</select>
      </div>
      <label className="field">Notes / justification<textarea className="input" rows={3} value={o.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
    </Modal>
  );
}

function OrderDetail({ id, onClose }: { id: ID; onClose: () => void }) {
  const { engine, fin } = useApp();
  const o = engine.get('orders', id)!;
  const [note, setNote] = useState('');
  const [po, setPo] = useState('');
  const [tracking, setTracking] = useState('');
  const canApprove = fin.canApprove(o);
  const behalf = fin.approvingOnBehalfOf(o);
  const next = fin.fulfilmentActions(o);
  const b = fin.budget(o.budgetId);
  return (
    <Modal wide title={`#${o.number} · ${o.title}`} onClose={onClose} footer={<>
      {o.requestedBy === engine.me && isPending(o.status) && <button className="btn danger" onClick={() => fin.setStatus(o.id, S.cancelled, { note: 'Withdrawn by requester' })}>Withdraw</button>}
      {fin.isAdmin && <button className="btn danger" onClick={() => { engine.remove('orders', o.id); fin.audit(`Deleted order #${o.number}`, o.title); onClose(); }}>Delete</button>}
      <button className="btn" title="Full order with approval trail, for auditors" onClick={printRecord}>🖨 Record (PDF)</button>
      <button className="btn" onClick={() => exportOrderRecord(engine, fin, o)}>⬇ Record (Excel)</button>
      <span className="grow" /><button className="btn" onClick={onClose}>Close</button>
    </>}>
      <OrderRecordPrint order={o} />
      <div className="row"><Pill text={o.status} color={statusColor(o.status)} />{o.isUnbudgeted && <span className="small red">UNBUDGETED</span>}<span className="right" style={{ fontSize: 22, fontWeight: 800 }}>{fin.money(orderAmount(o))}</span></div>
      <div className="props">
        <span className="k">Type</span><span>{o.type === 'order' ? 'Purchase order' : 'Direct expense'}</span>
        <span className="k">Entity</span><span>{fin.entity(o.entityId)?.name}</span>
        <span className="k">Budget line</span><span>{b ? `${b.category} ${b.year} › ${fin.line(o.budgetId, o.lineItemId)?.name}` : 'Unbudgeted'}</span>
        <span className="k">Supplier</span><span>{[o.supplier, o.supplierEmail].filter(Boolean).join(' · ') || '—'}</span>
        <span className="k">Requested by</span><span>{member(engine, o.requestedBy)?.name} · {new Date(o.requestedDate).toLocaleString()}</span>
        {o.poNumber && <><span className="k">PO number</span><span>{o.poNumber}</span></>}
        {o.lpo && <><span className="k">LPO / invoice</span><span>{o.lpo}</span></>}
        {o.expectedDelivery && <><span className="k">Expected</span><span>{new Date(o.expectedDelivery).toLocaleDateString()}</span></>}
        {o.trackingNumber && <><span className="k">Tracking</span><span>{o.trackingNumber}</span></>}
        {o.actualDelivery && <><span className="k">Delivered</span><span>{new Date(o.actualDelivery).toLocaleDateString()}</span></>}
        <span className="k">Assigned to</span>
        <select className="input" value={o.assignedTo ?? ''} onChange={(e) => fin.assign(o.id, e.target.value || undefined)}><option value="">Unassigned</option>{engine.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
      </div>
      <table className="t"><thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Total</th></tr></thead>
        <tbody>{o.items.map((i) => <tr key={i.id}><td>{i.name}</td><td className="num">{i.qty}</td><td className="num">{fin.money(i.unitPrice)}</td><td className="num">{fin.money(i.qty * i.unitPrice)}</td></tr>)}</tbody></table>
      {o.notes && <p className="muted">{o.notes}</p>}
      {(canApprove || next.length > 0) && (
        <div className="card col" style={{ background: 'var(--accent-soft)' }}>
          <h3>{canApprove ? 'Your decision' : 'Fulfilment'}</h3>
          {behalf && <div className="small orange">You are approving on behalf of {member(engine, behalf)?.name} (delegated to you).</div>}
          <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row wrap">
            {(canApprove ? !fin.nextStatus(o.status, o) && o.type === 'order' : next.includes(S.ordered)) && <input className="input" placeholder="PO number" value={po} onChange={(e) => setPo(e.target.value)} style={{ width: 160 }} />}
            {!canApprove && next.includes(S.shipped) && <input className="input" placeholder="Tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} style={{ width: 160 }} />}
            <span className="grow" />
            {canApprove ? <>
              <button className="btn danger" onClick={() => { fin.reject(o.id, note || 'No reason given'); setNote(''); }}>Reject</button>
              <button className="btn primary" onClick={() => { fin.approve(o.id, note, po); setNote(''); }}>Approve</button>
            </> : next.map((s) => <button key={s} className={`btn ${s === S.cancelled ? 'danger' : 'primary'}`} onClick={() => { fin.setStatus(o.id, s, { note, tracking, poNumber: s === S.ordered ? po : undefined }); setNote(''); }}>Mark {s}</button>)}
          </div>
        </div>
      )}
      <SupplierLinks order={o} />
      <h3>History</h3>
      {[...o.history].reverse().map((h) => (
        <div key={h.id} className="row" style={{ alignItems: 'flex-start' }}>
          <Avatar m={member(engine, h.memberId)} size={20} />
          <div className="grow"><div>{h.action}{h.to ? ` → ${h.to}` : ''}</div>{h.note && <div className="small muted">{h.note}</div>}</div>
          <span className="small muted">{new Date(h.date).toLocaleString()}</span>
        </div>
      ))}
    </Modal>
  );
}

// ---------------------------------------------------------------- Catalog / shopping

export function CatalogPage() {
  const { engine, fin } = useApp();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [cart, setCart] = useState<{ id: ID; qty: number }[]>([]);
  const [checkout, setCheckout] = useState<Order | null>(null);
  const [item, setItem] = useState<CatalogItem | null>(null);
  const items = engine.list('catalog').filter((c) => c.status === 'approved' && (!cat || c.category === cat) && (!q || `${c.name} ${c.supplier}`.toLowerCase().includes(q.toLowerCase())));
  const pending = engine.list('catalog').filter((c) => c.status === 'pending');
  const lines = cart.map((l) => ({ l, c: engine.get('catalog', l.id)! })).filter((x) => x.c);
  const total = lines.reduce((a, x) => a + x.l.qty * x.c.unitPrice, 0);
  const setStatus = (c: CatalogItem, status: string) => { engine.put('catalog', { ...c, status }); fin.audit(`Catalog item ${status}`, c.name); };
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
      <div className="grow col">
        <div className="toolbar">
          <h1 className="grow">Shopping catalog</h1>
          <input className="input" placeholder="Search catalog" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{fin.settings.itemCategories.map((x) => <option key={x}>{x}</option>)}</select>
          <button className="btn primary" onClick={() => setItem({ id: uid(), name: '', category: fin.settings.itemCategories[0] ?? '', unitPrice: 0, unit: 'pcs', supplier: '', status: fin.isAdmin ? 'approved' : 'pending', addedBy: engine.me, addedDate: iso() })}>{fin.isAdmin ? '+ Add item' : '+ Request item'}</button>
        </div>
        {fin.isAdmin && pending.length > 0 && (
          <div className="card" style={{ background: 'color-mix(in srgb, var(--orange) 8%, transparent)' }}>
            <h3>Awaiting approval</h3>
            {pending.map((c) => <div key={c.id} className="row" style={{ padding: '4px 0' }}><span className="grow">{c.name} <span className="small muted">{c.category} · {fin.money(c.unitPrice)} · by {member(engine, c.addedBy)?.name}</span></span>
              <button className="btn sm" onClick={() => setStatus(c, 'rejected')}>Reject</button><button className="btn sm primary" onClick={() => setStatus(c, 'approved')}>Approve</button></div>)}
          </div>
        )}
        <div className="grid g3">
          {items.map((c) => (
            <div key={c.id} className="card col" style={{ gap: 4 }}>
              <span className="small faint">{c.category.toUpperCase()}</span>
              <strong>{c.name}</strong>
              <span className="small muted">{c.supplier}</span>
              <div className="row"><span className="mono grow">{fin.money(c.unitPrice)} / {c.unit}</span>
                {fin.isAdmin && <button className="btn sm ghost" onClick={() => setItem(c)}>Edit</button>}
                <button className="btn sm primary" onClick={() => setCart((cs) => cs.some((x) => x.id === c.id) ? cs.map((x) => x.id === c.id ? { ...x, qty: x.qty + 1 } : x) : [...cs, { id: c.id, qty: 1 }])}>🛒 Add</button></div>
            </div>
          ))}
        </div>
        {!items.length && <Empty icon="🛒" title="Catalog is empty" sub="Add approved items so people can order them in a few clicks." />}
      </div>
      <div className="card col" style={{ width: 300, flex: 'none', position: 'sticky', top: 0 }}>
        <h3>🛒 Cart</h3>
        {!lines.length && <span className="muted small">Add items from the catalog.</span>}
        {lines.map(({ l, c }) => (
          <div key={l.id} className="row"><span className="grow ellipsis">{c.name}</span>
            <input className="input" type="number" min={1} style={{ width: 60 }} value={l.qty} onChange={(e) => setCart(cart.map((x) => x.id === l.id ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x))} />
            <button className="btn ghost sm" onClick={() => setCart(cart.filter((x) => x.id !== l.id))}>✕</button></div>
        ))}
        <div className="row"><span className="grow">Total</span><strong>{fin.money(total)}</strong></div>
        <button className="btn primary" disabled={!lines.length || !engine.list('entities').length} onClick={() => {
          const o = newOrderDraft(engine.list('entities')[0].id, engine.me);
          o.title = 'Catalog order';
          o.items = lines.map(({ l, c }) => ({ id: uid(), name: c.name, qty: l.qty, unitPrice: c.unitPrice, catalogItemId: c.id }));
          const sups = [...new Set(lines.map((x) => x.c.supplier))];
          if (sups.length === 1) o.supplier = sups[0];
          setCheckout(o);
          setCart([]);
        }}>Checkout → create order</button>
      </div>
      {checkout && <OrderEditor draft={checkout} onClose={() => setCheckout(null)} />}
      {item && <CatalogItemEditor item={item} onClose={() => setItem(null)} />}
    </div>
  );
}

function CatalogItemEditor({ item, onClose }: { item: CatalogItem; onClose: () => void }) {
  const { engine, fin } = useApp();
  const [c, setC] = useState(item);
  const exists = !!engine.get('catalog', c.id);
  return (
    <Modal title={exists ? 'Edit catalog item' : fin.isAdmin ? 'Add catalog item' : 'Request catalog item'} onClose={onClose} footer={<>
      {exists && <button className="btn danger" onClick={() => { engine.remove('catalog', c.id); onClose(); }}>Remove</button>}
      <span className="grow" /><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!c.name.trim()} onClick={() => { engine.put('catalog', c); if (!exists) fin.audit(`Catalog item ${c.status === 'approved' ? 'added' : 'requested'}`, c.name); onClose(); }}>Save</button>
    </>}>
      <label className="field">Name<input className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
      <div className="grid g3">
        <label className="field">Category<select className="input" value={c.category} onChange={(e) => setC({ ...c, category: e.target.value })}>{fin.settings.itemCategories.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field">Unit price<input className="input" type="number" value={c.unitPrice} onChange={(e) => setC({ ...c, unitPrice: Number(e.target.value) })} /></label>
        <label className="field">Unit<input className="input" value={c.unit} onChange={(e) => setC({ ...c, unit: e.target.value })} /></label>
      </div>
      <label className="field">Supplier<input className="input" value={c.supplier} onChange={(e) => setC({ ...c, supplier: e.target.value })} /></label>
    </Modal>
  );
}

// ---------------------------------------------------------------- Contracts

export function ContractsPage() {
  const { engine, fin } = useApp();
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<Contract | null>(null);
  const all = engine.list('contracts');
  const contracts = all.filter((c) => !status || fin.contractStatus(c) === status).sort((a, b) => a.endDate.localeCompare(b.endDate));
  const active = all.filter((c) => ['Active', 'Expiring'].includes(fin.contractStatus(c)));
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="toolbar">
        <h1 className="grow">Contracts</h1>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['Active', 'Expiring', 'Expired', 'Renewing', 'Upcoming', 'Terminated'].map((x) => <option key={x}>{x}</option>)}</select>
        <button className="btn" onClick={() => download('contracts.xlsx', all.map((c) => ({ Title: c.title, Supplier: c.supplier, Type: c.type, Entity: fin.entity(c.entityId)?.name ?? '', Value: c.value, Start: c.startDate.slice(0, 10), End: c.endDate.slice(0, 10), 'Auto renew': c.autoRenew ? 'Yes' : 'No', Status: fin.contractStatus(c), Contact: c.contact, Email: c.email, Phone: c.phone })), 'Contracts')}>⬇ Excel</button>
        <button className="btn primary" onClick={() => setEditing({ id: uid(), title: '', supplier: '', type: fin.settings.contractTypes[0] ?? '', value: 0, startDate: iso(), endDate: iso(addDays(new Date(), 365)), autoRenew: false, terminated: false, contact: '', email: '', phone: '', notes: '' })}>+ New contract</button>
      </div>
      <div className="grid g4">
        <KPI label="Active contracts" value={active.length} icon="📄" color="#2FA86C" />
        <KPI label="Active value" value={fin.money(active.reduce((a, c) => a + c.value, 0))} icon="💰" color="#7B68EE" />
        <KPI label="Expiring in 60 days" value={all.filter((c) => fin.contractStatus(c) === 'Expiring').length} icon="⏰" color="#E8912D" />
        <KPI label="Expired" value={all.filter((c) => fin.contractStatus(c) === 'Expired').length} icon="⛔" color="#E5484D" />
      </div>
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table className="t"><thead><tr><th>Contract</th><th>Supplier</th><th>Type</th><th>Entity</th><th className="num">Value</th><th>Ends</th><th>Status</th></tr></thead>
          <tbody>{contracts.map((c) => (
            <tr key={c.id} className="click" onClick={() => setEditing(structuredClone(c))}><td><strong>{c.title}</strong></td><td>{c.supplier}</td><td>{c.type}</td><td>{fin.entity(c.entityId)?.name ?? '—'}</td>
              <td className="num">{fin.money(c.value)}</td><td>{new Date(c.endDate).toLocaleDateString()}</td><td><Pill text={fin.contractStatus(c)} color={statusColor(fin.contractStatus(c))} /></td></tr>
          ))}</tbody></table>
        {!contracts.length && <Empty icon="📄" title="No contracts" />}
      </div>
      {editing && <ContractEditor contract={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ContractEditor({ contract, onClose }: { contract: Contract; onClose: () => void }) {
  const { engine, fin } = useApp();
  const [c, setC] = useState(contract);
  const exists = !!engine.get('contracts', c.id);
  const f = (k: keyof Contract) => (e: { target: { value: string } }) => setC({ ...c, [k]: e.target.value });
  return (
    <Modal wide title={exists ? 'Edit contract' : 'New contract'} onClose={onClose} footer={<>
      {exists && <button className="btn danger" onClick={() => { engine.remove('contracts', c.id); fin.audit('Deleted contract', c.title); onClose(); }}>Delete</button>}
      <span className="grow" /><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!c.title.trim()} onClick={() => { engine.put('contracts', c); fin.audit('Saved contract', `${c.title} · ${c.supplier}`); onClose(); }}>Save</button>
    </>}>
      <div className="grid g3">
        <label className="field">Title<input className="input" value={c.title} onChange={f('title')} /></label>
        <label className="field">Supplier<input className="input" value={c.supplier} onChange={f('supplier')} /></label>
        <label className="field">Type<select className="input" value={c.type} onChange={f('type')}>{fin.settings.contractTypes.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field">Entity<select className="input" value={c.entityId ?? ''} onChange={(e) => { const x = { ...c }; if (e.target.value) x.entityId = e.target.value; else delete x.entityId; setC(x); }}><option value="">Whole organization</option>{engine.list('entities').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className="field">Value<input className="input" type="number" value={c.value} onChange={(e) => setC({ ...c, value: Number(e.target.value) })} /></label>
        <label className="field">Start<input className="input" type="date" value={toInputDate(c.startDate)} onChange={(e) => setC({ ...c, startDate: fromInputDate(e.target.value) ?? c.startDate })} /></label>
        <label className="field">End<input className="input" type="date" value={toInputDate(c.endDate)} onChange={(e) => setC({ ...c, endDate: fromInputDate(e.target.value) ?? c.endDate })} /></label>
        <label className="field">Contact<input className="input" value={c.contact} onChange={f('contact')} /></label>
        <label className="field">Email<input className="input" value={c.email} onChange={f('email')} /></label>
        <label className="field">Phone<input className="input" value={c.phone} onChange={f('phone')} /></label>
      </div>
      <div className="row"><label className="row"><input type="checkbox" checked={c.autoRenew} onChange={(e) => setC({ ...c, autoRenew: e.target.checked })} /> Renews automatically</label>
        <label className="row"><input type="checkbox" checked={c.terminated} onChange={(e) => setC({ ...c, terminated: e.target.checked })} /> Terminated</label></div>
      <label className="field">Notes<textarea className="input" rows={3} value={c.notes} onChange={f('notes')} /></label>
    </Modal>
  );
}

// ---------------------------------------------------------------- Savings

export function SavingsPage() {
  const { engine, fin } = useApp();
  const [y, setY] = useState<number | ''>('');
  const [e, setE] = useState('');
  const [editing, setEditing] = useState<Saving | null>(null);
  const items = engine.list('savings').filter((s) => (!e || s.entityId === e) && (!y || new Date(s.date).getFullYear() === y)).sort((a, b) => b.date.localeCompare(a.date));
  const byType = Object.entries(items.reduce<Record<string, number>>((a, s) => { a[s.type] = (a[s.type] ?? 0) + s.amount; return a; }, {})).sort((a, b) => b[1] - a[1]);
  const entities = engine.list('entities');
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="toolbar"><h1 className="grow">Savings</h1><Filters y={y} setY={setY} e={e} setE={setE} />
        <button className="btn" onClick={() => download('savings.xlsx', items.map((s) => ({ Date: s.date.slice(0, 10), Entity: fin.entity(s.entityId)?.name ?? '', Type: s.type, Amount: s.amount, Description: s.description, LPO: s.lpo })), 'Savings')}>⬇ Excel</button>
        <button className="btn primary" disabled={!entities.length} onClick={() => setEditing({ id: uid(), entityId: e || entities[0].id, type: fin.settings.savingsTypes[0] ?? 'Negotiation', amount: 0, date: iso(), description: '', lpo: '', recordedBy: engine.me })}>+ Record saving</button></div>
      <div className="grid g4">
        <KPI label="Total savings" value={fin.money(items.reduce((a, s) => a + s.amount, 0))} icon="💵" color="#2FA86C" />
        {byType.slice(0, 3).map(([t, v]) => <KPI key={t} label={t} value={fin.money(v)} icon="🏷" color="#12B5CB" />)}
      </div>
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table className="t"><thead><tr><th>Date</th><th>Entity</th><th>Type</th><th>Description</th><th>LPO</th><th className="num">Amount</th></tr></thead>
          <tbody>{items.map((s) => <tr key={s.id} className="click" onClick={() => setEditing(structuredClone(s))}><td>{new Date(s.date).toLocaleDateString()}</td><td>{fin.entity(s.entityId)?.name}</td><td>{s.type}</td><td>{s.description}</td><td>{s.lpo}</td><td className="num green">{fin.money(s.amount)}</td></tr>)}</tbody></table>
        {!items.length && <Empty icon="💵" title="No savings recorded" />}
      </div>
      {editing && (
        <Modal title="Saving" onClose={() => setEditing(null)} footer={<>
          {engine.get('savings', editing.id) && <button className="btn danger" onClick={() => { engine.remove('savings', editing.id); setEditing(null); }}>Delete</button>}
          <span className="grow" /><button className="btn" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn primary" disabled={editing.amount <= 0} onClick={() => { engine.put('savings', editing); fin.audit('Recorded saving', `${editing.type} · ${fin.money(editing.amount)}`); setEditing(null); }}>Save</button>
        </>}>
          <div className="grid g2">
            <label className="field">Entity<select className="input" value={editing.entityId} onChange={(ev) => setEditing({ ...editing, entityId: ev.target.value })}>{entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label className="field">Type<select className="input" value={editing.type} onChange={(ev) => setEditing({ ...editing, type: ev.target.value })}>{fin.settings.savingsTypes.map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="field">Amount<input className="input" type="number" value={editing.amount} onChange={(ev) => setEditing({ ...editing, amount: Number(ev.target.value) })} /></label>
            <label className="field">Date<input className="input" type="date" value={toInputDate(editing.date)} onChange={(ev) => setEditing({ ...editing, date: fromInputDate(ev.target.value) ?? editing.date })} /></label>
            <label className="field">Description<input className="input" value={editing.description} onChange={(ev) => setEditing({ ...editing, description: ev.target.value })} /></label>
            <label className="field">LPO<input className="input" value={editing.lpo} onChange={(ev) => setEditing({ ...editing, lpo: ev.target.value })} /></label>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Analytics

export function AnalyticsPage() {
  const { engine, fin } = useApp();
  const [tab, setTab] = useState<'yoy' | 'variance' | 'spend' | 'time'>('yoy');
  const budgets = engine.list('budgets');
  const orders = engine.list('orders');
  const years = [...fin.settings.years].sort();
  const cats = [...new Set(budgets.map((b) => b.category))].sort();
  const yoy = useMemo(() => cats.map((c) => ({ c, figs: years.map((y) => budgets.filter((b) => b.category === c && b.year === y).map((b) => fin.budgetFigures(b)).reduce(add, zero())) })), [engine.version]);
  const variance = budgets.flatMap((b) => b.lineItems.map((l) => ({ budget: `${fin.entity(b.entityId)?.name} · ${b.category} ${b.year}`, line: l.name, f: fin.figures(b.id, l.id) }))).sort((a, b) => utilization(b.f) - utilization(a.f));
  const out = orders.filter(isOutgoing);
  // Same item bought at different prices: show the spread.
  const prices = new Map<string, { name: string; p: number[] }>();
  for (const i of out.flatMap((o) => o.items)) {
    if (i.unitPrice <= 0) continue;
    const k = i.name.trim().toLowerCase();
    if (!prices.has(k)) prices.set(k, { name: i.name, p: [] });
    prices.get(k)!.p.push(i.unitPrice);
  }
  const priceVar = [...prices.values()].map((x) => ({ name: x.name, lo: Math.min(...x.p), hi: Math.max(...x.p), n: x.p.length }))
    .filter((x) => x.n > 1 && x.hi > x.lo).sort((a, b) => (b.hi - b.lo) / b.lo - (a.hi - a.lo) / a.lo);
  const steps = [S.approved, S.ordered, S.shipped, S.delivered, S.completed];
  const stepAvg = steps.map((s) => {
    const v = orders.filter((o) => o.type === 'order').map((o) => { const e = o.history.find((h) => h.to === s); return e && o.history[0] ? (new Date(e.date).getTime() - new Date(o.history[0].date).getTime()) / 86400000 : null; }).filter((x): x is number => x !== null);
    return { s, avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null };
  }).filter((x) => x.avg !== null);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="toolbar"><h1 className="grow">Analytics</h1>
        <div className="seg">{([['yoy', 'Year over year'], ['variance', 'Budget variance'], ['spend', 'Spend analysis'], ['time', 'Order time']] as const).map(([v, l]) => <button key={v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{l}</button>)}</div>
        <button className="btn no-print" onClick={() => window.print()}>🖨 PDF</button>
      </div>
      {tab === 'yoy' && <div className="card col">
        <ChartBox height={280} config={{ type: 'bar', data: { labels: cats, datasets: years.map((y, i) => ({ label: String(y), data: yoy.map((r) => r.figs[i].spent + r.figs[i].committed), backgroundColor: CHART_COLORS[i % CHART_COLORS.length] })) } }} />
        <table className="t"><thead><tr><th>Category</th>{years.map((y) => <th key={y} className="num">{y} budget / spent</th>)}</tr></thead>
          <tbody>{yoy.map((r) => <tr key={r.c}><td>{r.c}</td>{r.figs.map((f, i) => <td key={i} className="num">{fin.money(f.allocated)} / {fin.money(f.spent + f.committed)}</td>)}</tr>)}</tbody></table>
        <button className="btn" onClick={() => download('yoy.xlsx', yoy.map((r) => Object.fromEntries([['Category', r.c], ...years.flatMap((y, i) => [[`${y} budget`, r.figs[i].allocated], [`${y} spent`, r.figs[i].spent + r.figs[i].committed]])])), 'YoY')}>⬇ Excel</button>
      </div>}
      {tab === 'variance' && <div className="card">
        <table className="t"><thead><tr><th>Budget</th><th>Line</th><th className="num">Allocated</th><th className="num">Actual</th><th className="num">Variance</th><th style={{ width: 140 }}>Used</th></tr></thead>
          <tbody>{variance.map((r, i) => { const act = r.f.spent + r.f.committed; return <tr key={i}><td className="muted">{r.budget}</td><td>{r.line}</td><td className="num">{fin.money(r.f.allocated)}</td><td className="num">{fin.money(act)}</td><td className={`num ${act > r.f.allocated ? 'red' : 'green'}`}>{fin.money(r.f.allocated - act)}</td><td><UtilBar {...r.f} /></td></tr>; })}</tbody></table>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => download('variance.xlsx', variance.map((r) => ({ Budget: r.budget, Line: r.line, Allocated: r.f.allocated, Actual: r.f.spent + r.f.committed, Variance: r.f.allocated - r.f.spent - r.f.committed })), 'Variance')}>⬇ Excel</button>
      </div>}
      {tab === 'spend' && <div className="col">
        <div className="grid g2">
          <div className="card"><h3>By item category</h3><ChartBox config={{ type: 'pie', data: (() => { const g = out.reduce<Record<string, number>>((a, o) => { const k = o.itemCategory || 'Uncategorized'; a[k] = (a[k] ?? 0) + orderAmount(o); return a; }, {}); return { labels: Object.keys(g), datasets: [{ data: Object.values(g), backgroundColor: CHART_COLORS }] }; })() }} /></div>
          <div className="card"><h3>By entity</h3><ChartBox config={{ type: 'bar', data: (() => { const g = out.reduce<Record<string, number>>((a, o) => { const k = fin.entity(o.entityId)?.name ?? '?'; a[k] = (a[k] ?? 0) + orderAmount(o); return a; }, {}); return { labels: Object.keys(g), datasets: [{ label: 'Spend', data: Object.values(g), backgroundColor: '#7B68EE' }] }; })(), options: { indexAxis: 'y' } }} /></div>
        </div>
        <div className="card"><h3>Price variance (same item, different prices)</h3>
          <table className="t"><thead><tr><th>Item</th><th className="num">Lowest</th><th className="num">Highest</th><th className="num">Spread</th><th className="num">Purchases</th></tr></thead>
            <tbody>{priceVar.slice(0, 20).map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{fin.money(p.lo)}</td><td className="num">{fin.money(p.hi)}</td><td className="num orange">{Math.round(((p.hi - p.lo) / Math.max(p.lo, 1)) * 100)}%</td><td className="num">{p.n}</td></tr>)}</tbody></table>
          {!priceVar.length && <p className="muted">No repeated items with different prices yet.</p>}</div>
      </div>}
      {tab === 'time' && <div className="card">
        <h3>Average days from request to each milestone</h3>
        <ChartBox config={{ type: 'bar', data: { labels: stepAvg.map((x) => x.s), datasets: [{ label: 'Days', data: stepAvg.map((x) => Math.round(x.avg! * 10) / 10), backgroundColor: '#12B5CB' }] } }} />
        {!stepAvg.length && <p className="muted">Order timings appear once orders move through approval and delivery.</p>}
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------- Reports

export function ReportsPage() {
  const { engine, fin } = useApp();
  const budgetsRows = () => engine.list('budgets').flatMap((b) => b.lineItems.map((l) => { const f = fin.figures(b.id, l.id); return { Entity: fin.entity(b.entityId)?.name ?? '', Year: b.year, Category: b.category, 'Line item': l.name, Allocated: f.allocated, Spent: f.spent, Committed: f.committed, Pending: f.pending, Balance: balance(f), 'Utilization %': Math.round(utilization(f) * 100) }; }));
  const ordersRows = (os: Order[]) => os.map((o) => ({ Number: o.number, Type: o.type, Title: o.title, Entity: fin.entity(o.entityId)?.name ?? '', Supplier: o.supplier, Amount: orderAmount(o), Status: o.status, Unbudgeted: o.isUnbudgeted ? 'Yes' : 'No', Requested: o.requestedDate.slice(0, 10), PO: o.poNumber }));
  const reports: [string, () => void][] = [
    ['Budgets & line items', () => download('budgets.xlsx', budgetsRows(), 'Budgets')],
    ['Orders & expenses', () => download('orders.xlsx', ordersRows(engine.list('orders')), 'Orders')],
    ['Unbudgeted spend', () => download('unbudgeted.xlsx', ordersRows(engine.list('orders').filter((o) => o.isUnbudgeted)), 'Unbudgeted')],
    ['Savings', () => download('savings.xlsx', engine.list('savings').map((s) => ({ Date: s.date.slice(0, 10), Entity: fin.entity(s.entityId)?.name ?? '', Type: s.type, Amount: s.amount, Description: s.description })), 'Savings')],
    ['Contracts', () => download('contracts.xlsx', engine.list('contracts').map((c) => ({ Title: c.title, Supplier: c.supplier, Value: c.value, End: c.endDate.slice(0, 10), Status: fin.contractStatus(c) })), 'Contracts')],
    ['Projects & tasks', () => download('tasks.xlsx', engine.list('tasks').filter((t) => !t.archived).map((t) => ({ Title: t.title, List: engine.get('lists', t.listId)?.name ?? '', Priority: t.priority, Due: t.dueDate?.slice(0, 10) ?? '', Assignees: t.assigneeIds.map((a) => member(engine, a)?.name).join(', ') })), 'Tasks')],
    ['Audit log', () => download('audit-log.xlsx', engine.list('audit').sort((a, b) => b.date.localeCompare(a.date)).map((a) => ({ Date: a.date, User: member(engine, a.memberId)?.name ?? '', Action: a.action, Details: a.details })), 'Audit')],
  ];
  return (
    <div className="card col" style={{ maxWidth: 720 }}>
      <h1>Reports</h1>
      <p className="muted">Download Excel workbooks, or open Finance overview / Analytics and use Print → Save as PDF for a formatted report.</p>
      {reports.map(([name, f]) => <div key={name} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}><span className="grow">{name}</span><button className="btn" onClick={f}>⬇ Excel</button></div>)}
    </div>
  );
}

// ---------------------------------------------------------------- Settings & audit

export function FinanceSettingsPage() {
  const { engine, fin } = useApp();
  const ents = engine.list('entities');
  const lists: [keyof typeof fin.settings, string][] = [['categories', 'Budget categories'], ['contractTypes', 'Contract types'], ['itemCategories', 'Item categories'], ['savingsTypes', 'Savings types']];
  const disabled = !fin.isAdmin;
  return (
    <div className="col" style={{ gap: 14, maxWidth: 900 }}>
      <h1>Finance settings</h1>
      {disabled && <p className="orange">Only workspace owners and admins can change finance settings.</p>}
      <div className="card col">
        <div className="row"><h2 className="grow">Entities & approval chains</h2><button className="btn primary" disabled={disabled} onClick={() => engine.put('entities', { id: uid(), name: 'New entity', code: '', approvalLevels: ['Requestor', 'Manager', 'Entity Manager'], roles: [] })}>+ Entity</button></div>
        {ents.map((e) => (
          <div key={e.id} className="card col" style={{ background: 'var(--bg)' }}>
            <div className="row">
              <input className="input grow" value={e.name} disabled={disabled} onChange={(ev) => engine.update('entities', e.id, (x) => { x.name = ev.target.value; })} />
              <input className="input" placeholder="Code" style={{ width: 90 }} value={e.code} disabled={disabled} onChange={(ev) => engine.update('entities', e.id, (x) => { x.code = ev.target.value; })} />
              <button className="btn danger" disabled={disabled || engine.list('budgets').some((b) => b.entityId === e.id) || engine.list('orders').some((o) => o.entityId === e.id)} title="Entities with budgets or orders can't be deleted" onClick={() => engine.remove('entities', e.id)}>Delete</button>
            </div>
            <div className="small muted">Approval chain (orders move left → right)</div>
            <div className="row wrap">
              {e.approvalLevels.map((l, i) => (
                <span key={l} className="row"><Pill text={`${i + 1}. ${l}`} color="#7B68EE" />
                  {l !== 'Requestor' && !disabled && <button className="btn ghost sm" onClick={() => engine.update('entities', e.id, (x) => { x.approvalLevels.splice(i, 1); })}>✕</button>}
                  {i < e.approvalLevels.length - 1 && '→'}</span>
              ))}
              {!disabled && <input className="input" placeholder="Add level + Enter" style={{ width: 150 }} onKeyDown={(ev) => { const v = (ev.target as HTMLInputElement).value.trim(); if (ev.key === 'Enter' && v && !e.approvalLevels.includes(v)) { engine.update('entities', e.id, (x) => { x.approvalLevels.push(v); }); (ev.target as HTMLInputElement).value = ''; } }} />}
            </div>
            <div className="small muted">People in this entity</div>
            {engine.members.map((m) => (
              <div key={m.id} className="row"><Avatar m={m} size={20} /><span style={{ width: 200 }}>{m.name}</span>
                <select className="input" disabled={disabled} value={e.roles.find((r) => r.memberId === m.id)?.role ?? ''} onChange={(ev) => engine.update('entities', e.id, (x) => { x.roles = x.roles.filter((r) => r.memberId !== m.id); if (ev.target.value) x.roles.push({ memberId: m.id, role: ev.target.value }); })}>
                  <option value="">No role</option>{e.approvalLevels.map((l) => <option key={l}>{l}</option>)}</select></div>
            ))}
          </div>
        ))}
      </div>
      <DelegationsCard />
      <div className="grid g2">
        <div className="card col"><h3>Fiscal years</h3><Chips values={fin.settings.years.map(String)} disabled={disabled} onChange={(v) => fin.saveSettings((s) => { s.years = v.map(Number).filter(Boolean).sort(); })} /></div>
        {lists.map(([k, label]) => <div key={k} className="card col"><h3>{label}</h3><Chips values={fin.settings[k] as string[]} disabled={disabled} onChange={(v) => fin.saveSettings((s) => { (s[k] as string[]) = v; })} /></div>)}
        <div className="card col"><h3>Currency</h3><input className="input" disabled={disabled} value={fin.settings.currency} onChange={(e) => fin.saveSettings((s) => { s.currency = e.target.value; })} /></div>
      </div>
    </div>
  );
}

function Chips({ values, onChange, disabled }: { values: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div className="row wrap">
      {values.map((v) => <span key={v} className="tag" style={{ background: 'var(--hover)', fontSize: 13 }}>{v}{!disabled && <button className="btn ghost sm" onClick={() => onChange(values.filter((x) => x !== v))}>✕</button>}</span>)}
      {!disabled && <input className="input" placeholder="Add + Enter" style={{ width: 130 }} onKeyDown={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (e.key === 'Enter' && v && !values.includes(v)) { onChange([...values, v]); (e.target as HTMLInputElement).value = ''; } }} />}
    </div>
  );
}

export function AuditPage() {
  const { engine } = useApp();
  const [q, setQ] = useState('');
  const rows = engine.list('audit').sort((a, b) => b.date.localeCompare(a.date)).filter((a) => !q || `${a.action} ${a.details} ${member(engine, a.memberId)?.name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="card col">
      <div className="row"><h2 className="grow">Audit log</h2><input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <table className="t"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>{rows.slice(0, 500).map((a) => <tr key={a.id}><td>{new Date(a.date).toLocaleString()}</td><td><span className="row"><Avatar m={member(engine, a.memberId)} size={18} />{member(engine, a.memberId)?.name}</span></td><td>{a.action}</td><td className="muted">{a.details}</td></tr>)}</tbody></table>
      {!rows.length && <Empty icon="📜" title="No audit entries" />}
    </div>
  );
}
