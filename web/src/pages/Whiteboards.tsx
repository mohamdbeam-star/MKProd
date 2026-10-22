// Whiteboards: stickies, text, boxes and circles on a zoomable canvas with connectors, colours,
// resize and "convert to task". Reads and writes the same board records as the Mac app, so a
// board edited on the website (or in the Windows / Android apps) is the one the Mac shows.
import { useEffect, useRef, useState } from 'react';
import { BoardItem, BoardItemKind, ID, Whiteboard, newTask, uid } from '../model';
import { Empty, member, useApp } from '../ui';

const W = 2400, H = 1600;
const COLORS = ['#FFE27A', '#A7F3D0', '#BFDBFE', '#FBCFE8', '#FED7AA', '#E9D5FF', '#2F3A4A'];
const KINDS: { kind: BoardItemKind; label: string; icon: string }[] = [
  { kind: 'sticky', label: 'Sticky', icon: '🗒' }, { kind: 'text', label: 'Text', icon: 'T' }, { kind: 'rectangle', label: 'Box', icon: '▭' }, { kind: 'ellipse', label: 'Circle', icon: '◯' },
];

export function WhiteboardsPage({ id }: { id?: ID }) {
  const { engine, go } = useApp();
  const boards = engine.list('whiteboards').sort((a, b) => a.name.localeCompare(b.name));
  const board = engine.get('whiteboards', id);
  const create = () => {
    const name = prompt('Name of the new whiteboard', 'Brainstorm');
    if (!name?.trim()) return;
    const b: Whiteboard = { id: uid(), name: name.trim(), items: [], connectors: [] };
    engine.put('whiteboards', b);
    go('whiteboards/' + b.id);
  };
  if (board) return <BoardEditor key={board.id} board={board} />;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="toolbar"><h1 className="grow">Whiteboards</h1>{engine.canWrite && <button className="btn primary" onClick={create}>+ New whiteboard</button>}</div>
      {!boards.length && <Empty icon="🧩" title="No whiteboards yet" sub="Stickies, text, shapes and connectors for brainstorming and planning; shared with every device and the Mac app." />}
      <div className="grid g3">
        {boards.map((b) => (
          <div key={b.id} className="card col click" style={{ gap: 6, cursor: 'pointer' }} onClick={() => go('whiteboards/' + b.id)}>
            <BoardThumb board={b} />
            <strong className="ellipsis">{b.name}</strong>
            <span className="small muted">{b.items.length} item{b.items.length === 1 ? '' : 's'} · {b.connectors.length} connector{b.connectors.length === 1 ? '' : 's'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Small preview of a board for the list. */
function BoardThumb({ board }: { board: Whiteboard }) {
  const xs = board.items.map((i) => i.x), ys = board.items.map((i) => i.y);
  const minX = Math.min(0, ...xs), minY = Math.min(0, ...ys);
  const maxX = Math.max(W / 2, ...board.items.map((i) => i.x + i.width)), maxY = Math.max(H / 2, ...board.items.map((i) => i.y + i.height));
  return (
    <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} style={{ width: '100%', height: 110, background: 'var(--hover)', borderRadius: 8 }} aria-hidden>
      {board.connectors.map((c) => { const a = board.items.find((i) => i.id === c.from), b = board.items.find((i) => i.id === c.to); return a && b ? <line key={c.id} x1={a.x + a.width / 2} y1={a.y + a.height / 2} x2={b.x + b.width / 2} y2={b.y + b.height / 2} stroke="#87909E" strokeWidth={6} strokeDasharray="18 12" /> : null; })}
      {board.items.map((i) => i.kind === 'ellipse'
        ? <ellipse key={i.id} cx={i.x + i.width / 2} cy={i.y + i.height / 2} rx={i.width / 2} ry={i.height / 2} fill="none" stroke={strokeFor(i)} strokeWidth={8} />
        : <rect key={i.id} x={i.x} y={i.y} width={i.width} height={i.height} rx={12} fill={i.kind === 'sticky' ? i.colorHex : 'none'} stroke={i.kind === 'rectangle' ? strokeFor(i) : i.kind === 'text' ? i.colorHex : 'none'} strokeWidth={8} opacity={i.kind === 'text' ? 0.5 : 1} />)}
    </svg>
  );
}

const strokeFor = (i: BoardItem) => (i.colorHex === '#FFE27A' ? (i.kind === 'ellipse' ? '#3DBE7A' : '#5B8DEF') : i.colorHex);

function BoardEditor({ board }: { board: Whiteboard }) {
  const { engine, go, openTask, toast } = useApp();
  const canWrite = engine.canWrite;
  const [selected, setSelected] = useState<ID | null>(null);
  const [connecting, setConnecting] = useState<ID | null>(null);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ id: ID; dx: number; dy: number } | null>(null);
  const [resize, setResize] = useState<{ id: ID; dw: number; dh: number } | null>(null);
  const pointer = useRef<{ id: ID; kind: 'move' | 'resize'; x: number; y: number; moved: boolean } | null>(null);

  const mutate = (fn: (b: Whiteboard) => void) => { if (canWrite) engine.update('whiteboards', board.id, fn); };
  const mutateItem = (id: ID, fn: (i: BoardItem) => void) => mutate((b) => { const it = b.items.find((x) => x.id === id); if (it) fn(it); });
  const sel = board.items.find((i) => i.id === selected);

  const add = (kind: BoardItemKind) => {
    const n = board.items.length;
    const it: BoardItem = { id: uid(), kind, text: kind === 'text' ? 'Heading' : '', x: 120 + (n % 6) * 40, y: 120 + (n % 6) * 30, width: 160, height: 120, colorHex: '#FFE27A' };
    if (kind === 'text') { it.width = 260; it.height = 44; it.colorHex = '#2F3A4A'; }
    if (kind === 'ellipse') { it.width = 140; it.height = 140; }
    mutate((b) => { b.items.push(it); });
    setSelected(it.id);
  };
  const removeItem = (id: ID) => { mutate((b) => { b.items = b.items.filter((i) => i.id !== id); b.connectors = b.connectors.filter((c) => c.from !== id && c.to !== id); }); setSelected(null); };
  const toTask = (it: BoardItem) => {
    const list = engine.list('lists').find((l) => !l.archived) ?? engine.list('lists')[0];
    if (!list) { toast('Create a list first'); return; }
    const space = engine.get('spaces', list.spaceId);
    const t = newTask(list.id, it.text.trim() || 'Whiteboard item', space?.statuses[0]?.id ?? '', member(engine, engine.me));
    t.details = `Created from whiteboard "${board.name}"`;
    engine.put('tasks', t);
    openTask(t.id);
  };

  // Pointer handling: drag an item (or its resize handle); clicks select / connect.
  const down = (e: React.PointerEvent, id: ID, kind: 'move' | 'resize') => {
    if (!canWrite) { setSelected(id); return; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointer.current = { id, kind, x: e.clientX, y: e.clientY, moved: false };
    e.stopPropagation();
  };
  const move = (e: React.PointerEvent) => {
    const p = pointer.current;
    if (!p) return;
    const dx = (e.clientX - p.x) / zoom, dy = (e.clientY - p.y) / zoom;
    if (Math.abs(dx) + Math.abs(dy) > 2) p.moved = true;
    if (!p.moved) return;
    if (p.kind === 'move') setDrag({ id: p.id, dx, dy }); else setResize({ id: p.id, dw: dx, dh: dy });
  };
  const up = (e: React.PointerEvent) => {
    const p = pointer.current;
    pointer.current = null;
    if (!p) return;
    const dx = (e.clientX - p.x) / zoom, dy = (e.clientY - p.y) / zoom;
    setDrag(null); setResize(null);
    if (p.moved) {
      if (p.kind === 'move') mutateItem(p.id, (i) => { i.x = Math.max(0, Math.round(i.x + dx)); i.y = Math.max(0, Math.round(i.y + dy)); });
      else mutateItem(p.id, (i) => { i.width = Math.max(60, Math.round(i.width + dx)); i.height = Math.max(30, Math.round(i.height + dy)); });
      setSelected(p.id);
      return;
    }
    // A click: finish a connection or select.
    if (connecting && connecting !== p.id) { mutate((b) => { if (!b.connectors.some((c) => c.from === connecting && c.to === p.id)) b.connectors.push({ id: uid(), from: connecting, to: p.id }); }); setConnecting(null); }
    setSelected(p.id);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'INPUT';
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !typing) { e.preventDefault(); removeItem(selected); }
      if (e.key === 'Escape') { setConnecting(null); if (!typing) setSelected(null); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const pos = (i: BoardItem) => {
    const d = drag?.id === i.id ? drag : null, r = resize?.id === i.id ? resize : null;
    return { x: i.x + (d?.dx ?? 0), y: i.y + (d?.dy ?? 0), w: Math.max(60, i.width + (r?.dw ?? 0)), h: Math.max(30, i.height + (r?.dh ?? 0)) };
  };

  return (
    <div className="wb col">
      <div className="toolbar wb-bar">
        <input className="plain" style={{ fontSize: 18, fontWeight: 700, width: 220 }} value={board.name} readOnly={!canWrite} onChange={(e) => mutate((b) => { b.name = e.target.value; })} aria-label="Whiteboard name" />
        {canWrite && KINDS.map((k) => <button key={k.kind} className="btn" onClick={() => add(k.kind)} title={`Add ${k.label.toLowerCase()}`}><span style={{ fontWeight: 700 }}>{k.icon}</span> {k.label}</button>)}
        {sel && canWrite && (
          <>
            <span className="wb-sep" />
            <button className={`btn ${connecting ? 'primary' : ''}`} onClick={() => setConnecting(connecting ? null : sel.id)}>{connecting ? 'Pick the target…' : '→ Connect'}</button>
            <span className="wb-colors" role="group" aria-label="Colour">{COLORS.map((h) => <button key={h} className={`wb-swatch ${sel.colorHex === h ? 'on' : ''}`} style={{ background: h }} title={h} onClick={() => mutateItem(sel.id, (i) => { i.colorHex = h; })} />)}</span>
            <button className="btn" onClick={() => toTask(sel)}>✓ Convert to task</button>
            <button className="btn danger" onClick={() => removeItem(sel.id)} title="Delete (⌫)">🗑</button>
          </>
        )}
        <span className="grow" />
        <button className="btn sm" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">−</button>
        <span className="mono small" style={{ width: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <button className="btn sm" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">+</button>
        <button className="btn sm" onClick={() => go('whiteboards')}>All boards</button>
        {canWrite && <button className="btn sm danger" onClick={() => { if (confirm(`Delete the whiteboard "${board.name}"?`)) { engine.remove('whiteboards', board.id); go('whiteboards'); } }}>Delete board</button>}
      </div>
      {connecting && <div className="small muted">Click another item to connect it to the selected one. Esc cancels.</div>}
      <div className="wb-canvas card" onPointerDown={() => { setSelected(null); setConnecting(null); }}>
        <div className="wb-world" style={{ width: W * zoom, height: H * zoom }}>
          <div className="wb-scale" style={{ width: W, height: H, transform: `scale(${zoom})` }}>
            <svg className="wb-lines" width={W} height={H} aria-hidden>
              {board.connectors.map((c) => {
                const a = board.items.find((i) => i.id === c.from), b = board.items.find((i) => i.id === c.to);
                if (!a || !b) return null;
                const pa = pos(a), pb = pos(b);
                return <line key={c.id} x1={pa.x + pa.w / 2} y1={pa.y + pa.h / 2} x2={pb.x + pb.w / 2} y2={pb.y + pb.h / 2} />;
              })}
            </svg>
            {board.items.map((it) => {
              const p = pos(it);
              const isSel = selected === it.id;
              const editing = isSel && canWrite;
              const style: React.CSSProperties = { left: p.x, top: p.y, width: p.w, height: p.h };
              if (it.kind === 'sticky') { style.background = it.colorHex; style.color = '#111'; }
              if (it.kind === 'text') style.color = it.colorHex;
              if (it.kind === 'rectangle') style.borderColor = strokeFor(it);
              if (it.kind === 'ellipse') style.borderColor = strokeFor(it);
              return (
                <div key={it.id} className={`wb-item ${it.kind} ${isSel ? 'on' : ''} ${connecting && connecting !== it.id ? 'target' : ''}`} style={style}
                  onPointerDown={(e) => down(e, it.id, 'move')} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { pointer.current = null; setDrag(null); setResize(null); }}>
                  {editing && <div className="wb-grip" title="Drag to move" />}
                  <textarea className="wb-text" value={it.text} readOnly={!editing} tabIndex={editing ? 0 : -1} placeholder={it.kind === 'sticky' ? 'Type…' : ''}
                    onChange={(e) => mutateItem(it.id, (i) => { i.text = e.target.value; })} onPointerDown={(e) => { if (editing) e.stopPropagation(); }} />
                  {editing && <div className="wb-resize" title="Drag to resize" onPointerDown={(e) => down(e, it.id, 'resize')} onPointerMove={move} onPointerUp={up} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {!board.items.length && <div className="small muted">Add a sticky, text, box or circle from the toolbar. Click an item to select it; drag it to move, drag its corner to resize, and use Connect to draw a line to another item.</div>}
    </div>
  );
}
