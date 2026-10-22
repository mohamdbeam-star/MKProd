// Budget & procurement rules. Mirrors Sources/MKProd/FinanceStore.swift so the website and
// the Mac app agree on statuses, approvals and budget figures.

import { Budget, Contract, FINANCE_SETTINGS_ID, ID, Order, addDays, defaultFinanceSettings, iso, startOfDay, uid } from './model';
import type { SyncEngine } from './sync';

export const S = {
  approved: 'Approved', ordered: 'Ordered', shipped: 'Shipped', delivered: 'Delivered', completed: 'Completed',
  rejected: 'Rejected', cancelled: 'Cancelled', recorded: 'Recorded', unbudgeted: 'Pending Unbudgeted Approval',
};
export const isPending = (s: string) => s.startsWith('Pending');
export const isCommitted = (s: string) => [S.approved, S.ordered, S.shipped].includes(s);
export const isSpent = (s: string) => [S.delivered, S.completed, S.recorded].includes(s);
export const isOutgoing = (o: Order) => isCommitted(o.status) || isSpent(o.status) || (o.type === 'expense' && o.status === S.approved);
export const orderAmount = (o: Order) => o.items.reduce((a, i) => a + i.qty * i.unitPrice, 0);

export interface Figures { allocated: number; spent: number; committed: number; pending: number; savings: number }
export const zero = (): Figures => ({ allocated: 0, spent: 0, committed: 0, pending: 0, savings: 0 });
export const add = (a: Figures, b: Figures): Figures => ({
  allocated: a.allocated + b.allocated, spent: a.spent + b.spent, committed: a.committed + b.committed, pending: a.pending + b.pending, savings: a.savings + b.savings,
});
export const balance = (f: Figures) => f.allocated - f.spent - f.committed;
export const utilization = (f: Figures) => (f.allocated > 0 ? (f.spent + f.committed) / f.allocated : 0);

export class Finance {
  constructor(private e: SyncEngine) {}

  get settings() { return this.e.get('financeSettings', FINANCE_SETTINGS_ID) ?? defaultFinanceSettings(); }
  get isAdmin() { return this.e.isAdmin; }

  saveSettings(fn: (s: ReturnType<typeof defaultFinanceSettings>) => void) {
    const s = structuredClone(this.settings);
    fn(s);
    this.e.put('financeSettings', s);
  }

  money(v: number) {
    return `${this.settings.currency} ${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }

  entity(id?: ID) { return this.e.get('entities', id); }
  budget(id?: ID) { return this.e.get('budgets', id); }
  line(b?: ID, l?: ID) { return this.budget(b)?.lineItems.find((x) => x.id === l); }

  figures(budgetId: ID, lineId: ID): Figures {
    const f = zero();
    f.allocated = this.line(budgetId, lineId)?.allocated ?? 0;
    for (const o of this.e.list('orders')) {
      if (o.budgetId !== budgetId || o.lineItemId !== lineId) continue;
      const amt = orderAmount(o);
      if (o.type === 'expense') {
        if (o.status === S.recorded || o.status === S.approved) f.spent += amt;
        else if (isPending(o.status)) f.pending += amt;
      } else if (isSpent(o.status)) f.spent += amt;
      else if (isCommitted(o.status)) f.committed += amt;
      else if (isPending(o.status)) f.pending += amt;
    }
    f.savings = this.e.list('savings').filter((s) => s.budgetId === budgetId && s.lineItemId === lineId).reduce((a, s) => a + s.amount, 0);
    return f;
  }

  budgetFigures(b: Budget): Figures {
    return b.lineItems.map((l) => this.figures(b.id, l.id)).reduce(add, zero());
  }

  // ---- workflow

  initialStatus(entityId: ID, type: 'order' | 'expense', unbudgeted: boolean) {
    if (type === 'expense') return unbudgeted ? S.unbudgeted : S.recorded;
    const levels = (this.entity(entityId)?.approvalLevels ?? []).filter((l) => l !== 'Requestor');
    return levels.length ? `Pending ${levels[0]}` : 'Pending Approval';
  }

  nextStatus(current: string, o: Order): string | null {
    if (current === S.unbudgeted) return null;
    const levels = (this.entity(o.entityId)?.approvalLevels ?? []).filter((l) => l !== 'Requestor');
    const i = levels.indexOf(current.replace('Pending ', ''));
    if (i >= 0 && i + 1 < levels.length) return `Pending ${levels[i + 1]}`;
    return o.isUnbudgeted ? S.unbudgeted : null;
  }

  /** Own authority, or an active delegation from someone who has it. */
  canApprove(o: Order, member: ID = this.e.me): boolean {
    if (this.canApproveDirectly(o, member)) return true;
    return this.delegatorsFor(member).some((from) => this.canApproveDirectly(o, from));
  }

  canApproveDirectly(o: Order, member: ID): boolean {
    if (!isPending(o.status) || o.status === 'Pending') return false;
    const memberIsAdmin = ['owner', 'admin'].includes(this.e.team.find((m) => m.id === member)?.role ?? (member === this.e.me ? this.e.role : ''));
    if (o.status === S.unbudgeted) return memberIsAdmin;
    if (memberIsAdmin) return true;
    const role = this.entity(o.entityId)?.roles.find((r) => r.memberId === member)?.role;
    if (!role || role === 'Requestor') return false;
    return o.status === `Pending ${role}` || o.status === 'Pending Approval';
  }

  /** Delegations in force today, oldest first. */
  activeDelegations(today = new Date()) {
    const t = startOfDay(today).getTime();
    return (this.settings.delegations ?? []).filter((d) => new Date(d.until).getTime() >= t);
  }

  delegatorsFor(member: ID): ID[] {
    return this.activeDelegations().filter((d) => d.to === member && d.from !== member).map((d) => d.from);
  }

  /** Who `member` is acting for when approving `o`, if not themself. */
  approvingOnBehalfOf(o: Order, member: ID = this.e.me): ID | undefined {
    if (this.canApproveDirectly(o, member)) return undefined;
    return this.delegatorsFor(member).find((from) => this.canApproveDirectly(o, from));
  }

  addDelegation(from: ID, to: ID, until: string, note = '') {
    this.saveSettings((s) => { s.delegations = [...(s.delegations ?? []), { id: uid(), from, to, until, note }]; });
    this.audit('Delegated approvals', `${this.e.members.find((m) => m.id === from)?.name} → ${this.e.members.find((m) => m.id === to)?.name} until ${until.slice(0, 10)}`);
  }

  removeDelegation(id: ID) {
    this.saveSettings((s) => { s.delegations = (s.delegations ?? []).filter((d) => d.id !== id); });
  }

  nextNumber() {
    return Math.max(this.settings.nextOrderNumber, Math.max(1000, ...this.e.list('orders').map((o) => o.number)) + 1);
  }

  createOrder(draft: Order): Order {
    const o: Order = structuredClone(draft);
    o.items = o.items.filter((i) => i.name.trim());
    o.number = this.nextNumber();
    o.isUnbudgeted = !o.budgetId || !o.lineItemId;
    if (o.isUnbudgeted) { delete o.budgetId; delete o.lineItemId; }
    o.status = this.initialStatus(o.entityId, o.type, o.isUnbudgeted);
    o.requestedBy = this.e.me;
    o.requestedDate = iso();
    o.currency = this.settings.currency;
    o.history = [{ id: uid(), date: iso(), memberId: this.e.me, action: o.type === 'expense' ? 'Recorded' : 'Submitted', from: '', to: o.status, note: '' }];
    o.updated = iso();
    this.e.put('orders', o);
    this.saveSettings((s) => { s.nextOrderNumber = o.number + 1; });
    this.audit(`Created ${o.type === 'order' ? 'purchase order' : 'direct expense'} #${o.number}`, `${o.title} · ${this.money(orderAmount(o))}`);
    return o;
  }

  private event(o: Order, action: string, to: string, note = '') {
    o.history.push({ id: uid(), date: iso(), memberId: this.e.me, action, from: '', to, note });
  }

  approve(id: ID, note = '', poNumber = '') {
    const o = this.e.get('orders', id);
    if (!o || !this.canApprove(o)) return;
    const next = this.nextStatus(o.status, o);
    const behalf = this.approvingOnBehalfOf(o);
    const tag = behalf ? ` (on behalf of ${this.e.members.find((m) => m.id === behalf)?.name ?? 'a colleague'})` : '';
    this.e.update('orders', id, (x) => {
      const from = x.status;
      if (poNumber) x.poNumber = poNumber;
      x.status = next ?? S.approved;
      if (!next) { x.approvedBy = this.e.me; x.approvedDate = iso(); }
      x.history.push({ id: uid(), date: iso(), memberId: this.e.me, action: 'Approved' + tag, from, to: x.status, note });
    });
    this.audit(`Approved order #${o.number}${tag}`, note);
  }

  reject(id: ID, reason: string) {
    const o = this.e.get('orders', id);
    if (!o || !this.canApprove(o)) return;
    const behalf = this.approvingOnBehalfOf(o);
    const tag = behalf ? ` (on behalf of ${this.e.members.find((m) => m.id === behalf)?.name ?? 'a colleague'})` : '';
    this.e.update('orders', id, (x) => {
      x.history.push({ id: uid(), date: iso(), memberId: this.e.me, action: 'Rejected' + tag, from: x.status, to: S.rejected, note: reason });
      x.status = S.rejected;
    });
    this.audit(`Rejected order #${o.number}${tag}`, reason);
  }

  setStatus(id: ID, status: string, opts: { note?: string; tracking?: string; poNumber?: string } = {}) {
    const o = this.e.get('orders', id);
    if (!o) return;
    this.e.update('orders', id, (x) => {
      const from = x.status;
      x.status = status;
      if (opts.tracking) x.trackingNumber = opts.tracking;
      if (opts.poNumber) x.poNumber = opts.poNumber;
      if (status === S.delivered) { x.actualDelivery = iso(); if (opts.note) x.deliveryNotes = opts.note; }
      x.history.push({ id: uid(), date: iso(), memberId: this.e.me, action: 'Status changed', from, to: status, note: opts.note ?? '' });
    });
    this.audit(`Order #${o.number} → ${status}`, opts.note ?? '');
  }

  assign(id: ID, member?: ID) {
    const o = this.e.get('orders', id);
    if (!o) return;
    const name = this.e.members.find((m) => m.id === member)?.name ?? 'Unassigned';
    this.e.update('orders', id, (x) => {
      if (member) x.assignedTo = member; else delete x.assignedTo;
      this.event(x, 'Assigned', '', name);
    });
    this.audit(`Assigned order #${o.number}`, name);
  }

  fulfilmentActions(o: Order): string[] {
    if (o.type !== 'order') return [];
    switch (o.status) {
      case S.approved: return [S.ordered, S.cancelled];
      case S.ordered: return [S.shipped, S.delivered, S.cancelled];
      case S.shipped: return [S.delivered];
      case S.delivered: return [S.completed];
      default: return [];
    }
  }

  audit(action: string, details = '') {
    this.e.put('audit', { id: uid(), date: iso(), memberId: this.e.me, action, details });
  }

  contractStatus(c: Contract, today = new Date()) {
    if (c.terminated) return 'Terminated';
    const end = new Date(c.endDate);
    if (end < startOfDay(today)) return c.autoRenew ? 'Renewing' : 'Expired';
    if (end < addDays(today, 60)) return 'Expiring';
    if (new Date(c.startDate) > today) return 'Upcoming';
    return 'Active';
  }

  alerts() {
    const out: { severity: number; title: string; detail: string; page: string }[] = [];
    for (const b of this.e.list('budgets')) {
      const en = this.entity(b.entityId)?.name ?? '';
      for (const l of b.lineItems) {
        if (l.allocated <= 0) continue;
        const f = this.figures(b.id, l.id);
        const u = utilization(f);
        if (u > 1) out.push({ severity: 2, title: `Over budget: ${l.name}`, detail: `${en} · ${b.category} ${b.year} · ${Math.round(u * 100)}% used`, page: 'budgets' });
        else if (u >= 0.9) out.push({ severity: 1, title: `Nearly exhausted: ${l.name}`, detail: `${en} · ${Math.round(u * 100)}% used, ${this.money(balance(f))} left`, page: 'budgets' });
      }
    }
    for (const c of this.e.list('contracts')) {
      const st = this.contractStatus(c);
      if (st === 'Expired') out.push({ severity: 2, title: `Contract expired: ${c.title}`, detail: `${c.supplier} · ended ${new Date(c.endDate).toLocaleDateString()}`, page: 'contracts' });
      if (st === 'Expiring') out.push({ severity: 1, title: `Contract expiring: ${c.title}`, detail: `${c.supplier} · ends ${new Date(c.endDate).toLocaleDateString()}`, page: 'contracts' });
    }
    const mine = this.e.list('orders').filter((o) => this.canApprove(o));
    if (mine.length) out.push({ severity: 1, title: `${mine.length} order(s) waiting for your approval`, detail: mine.slice(0, 3).map((o) => o.title).join(', '), page: 'approvals' });
    for (const o of this.e.list('orders')) {
      if (o.type === 'order' && [S.ordered, S.shipped].includes(o.status) && o.expectedDelivery && new Date(o.expectedDelivery) < startOfDay()) {
        out.push({ severity: 1, title: `Late delivery: #${o.number} ${o.title}`, detail: `Expected ${new Date(o.expectedDelivery).toLocaleDateString()}`, page: 'orders' });
      }
    }
    const pendingCatalog = this.e.list('catalog').filter((c) => c.status === 'pending').length;
    if (pendingCatalog && this.isAdmin) out.push({ severity: 0, title: `${pendingCatalog} catalog item(s) awaiting approval`, detail: '', page: 'catalog' });
    return out.sort((a, b) => b.severity - a.severity);
  }
}
