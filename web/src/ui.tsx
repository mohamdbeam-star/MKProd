import { createContext, ReactNode, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { Chart, registerables, ChartConfiguration } from 'chart.js';
import { ID, Member, PRIORITIES, StatusDef, Task, initials, priorityOf } from './model';
import type { SyncEngine } from './sync';
import type { Finance } from './finance';

Chart.register(...registerables);

export interface Ctx {
  engine: SyncEngine;
  fin: Finance;
  go: (route: string) => void;
  route: string;
  openTask: (id?: ID) => void;
  toast: (msg: string) => void;
}
export const AppCtx = createContext<Ctx>(null as unknown as Ctx);

/** Re-renders whenever the engine's data changes. */
export function useApp(): Ctx {
  const ctx = useContext(AppCtx);
  useSyncExternalStore((cb) => ctx.engine.subscribe(cb), () => ctx.engine.version);
  return ctx;
}

export function member(engine: SyncEngine, id?: ID): Member | undefined {
  return engine.members.find((m) => m.id === id);
}

// ---------------------------------------------------------------- primitives

export function Avatar({ m, size = 22 }: { m?: Member; size?: number }) {
  return (
    <span className="avatar" title={m?.name ?? 'Unassigned'} style={{ width: size, height: size, fontSize: size * 0.42, background: m?.colorHex ?? '#B0B7C3' }}>
      {m ? initials(m.name) : '?'}
    </span>
  );
}

export function Avatars({ ids, size = 22 }: { ids: ID[]; size?: number }) {
  const { engine } = useContext(AppCtx);
  if (!ids.length) return <span className="faint" title="Unassigned">👤</span>;
  return <span className="stack">{ids.slice(0, 4).map((id) => <Avatar key={id} m={member(engine, id)} size={size} />)}</span>;
}

export function Pill({ text, color }: { text: string; color: string }) {
  return <span className="pill" style={{ background: color + '26', color }}>{text}</span>;
}

export function StatusPill({ s }: { s?: StatusDef }) {
  const c = s?.colorHex ?? '#87909E';
  return <span className="pill" style={{ background: c + '26', color: c }}><span style={{ width: 7, height: 7, borderRadius: 4, background: c }} />{(s?.name ?? '—').toUpperCase()}</span>;
}

export function Flag({ p }: { p: number }) {
  const x = priorityOf(p);
  return <span title={x.label} style={{ color: x.color, opacity: p ? 1 : 0.4 }}>⚑</span>;
}

export function Tag({ t }: { t: string }) {
  const palette = ['#7B68EE', '#5B8DEF', '#3DBE7A', '#F0A33A', '#E5484D', '#D6409F', '#12B5CB', '#8E5CF7'];
  const c = palette[[...t].reduce((a, ch) => a + ch.charCodeAt(0), 0) % palette.length];
  return <span className="tag" style={{ background: c + '26', color: c }}>{t}</span>;
}

export function Empty({ icon, title, sub }: { icon: string; title: string; sub?: string }) {
  return <div className="empty"><div className="big">{icon}</div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>;
}

export function KPI({ label, value, color = 'var(--accent)', icon = '•' }: { label: string; value: ReactNode; color?: string; icon?: string }) {
  return (
    <div className="kpi" style={{ background: `color-mix(in srgb, ${color} 10%, transparent)` }}>
      <span style={{ fontSize: 22, color }}>{icon}</span>
      <div className="grow"><div className="v ellipsis">{value}</div><div className="l">{label}</div></div>
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="scrim top" onClick={onClose} />
      <div className="modal" style={wide ? { width: 'min(900px, calc(100% - 24px))' } : undefined} role="dialog" aria-label={title}>
        <div className="row" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <h2 className="grow">{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="body">{children}</div>
        {footer && <div className="foot">{footer}</div>}
      </div>
    </>
  );
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => <button key={String(o.value)} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function PrioritySelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
    </select>
  );
}

export function UtilBar({ allocated, spent, committed, pending }: { allocated: number; spent: number; committed: number; pending: number }) {
  const a = Math.max(allocated, 1);
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / a) * 100))}%`;
  return (
    <div className="bar-bg" title={`Spent ${spent} · Committed ${committed} · Pending ${pending} of ${allocated}`} style={spent + committed > allocated ? { outline: '1.5px solid var(--red)' } : undefined}>
      <span style={{ width: pct(spent), background: 'var(--green)' }} />
      <span style={{ width: pct(committed), background: 'var(--blue)' }} />
      <span style={{ width: pct(pending), background: 'var(--orange)', opacity: 0.6 }} />
    </div>
  );
}

/** Thin wrapper around Chart.js that rebuilds when the config changes. */
export function ChartBox({ config, height = 240 }: { config: ChartConfiguration; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify(config.data) + config.type;
  useEffect(() => {
    if (!ref.current) return;
    const c = new Chart(ref.current, { ...config, options: { responsive: true, maintainAspectRatio: false, ...config.options } });
    return () => c.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <div style={{ height, position: 'relative' }}><canvas ref={ref} /></div>;
}

export const CHART_COLORS = ['#7B68EE', '#3DBE7A', '#5B8DEF', '#F0A33A', '#E5484D', '#D6409F', '#12B5CB', '#8E5CF7', '#87909E', '#2F3A4A'];

/** Minimal Markdown for docs, descriptions and comments (text is escaped first). */
export function Markdown({ text }: { text: string }) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const html = text.split('\n').map((l) => {
    const t = l.trim();
    if (t.startsWith('### ')) return `<h3>${inline(t.slice(4))}</h3>`;
    if (t.startsWith('## ')) return `<h2>${inline(t.slice(3))}</h2>`;
    if (t.startsWith('# ')) return `<h1>${inline(t.slice(2))}</h1>`;
    if (/^- \[[ x]\] /.test(t)) return `<div>${t[3] === 'x' ? '☑' : '☐'} ${inline(t.slice(6))}</div>`;
    if (t.startsWith('- ') || t.startsWith('* ')) return `<div>• ${inline(t.slice(2))}</div>`;
    if (t.startsWith('> ')) return `<blockquote>${inline(t.slice(2))}</blockquote>`;
    if (t === '---') return '<hr/>';
    if (!t) return '<div style="height:6px"></div>';
    return `<p>${inline(l)}</p>`;
  }).join('');
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function statusOf(engine: SyncEngine, t: Task): StatusDef | undefined {
  const list = engine.get('lists', t.listId);
  const space = engine.get('spaces', list?.spaceId);
  return space?.statuses.find((s) => s.id === t.statusId);
}

export function isClosed(engine: SyncEngine, t: Task) {
  const k = statusOf(engine, t)?.kind;
  return k === 'done' || k === 'closed';
}
