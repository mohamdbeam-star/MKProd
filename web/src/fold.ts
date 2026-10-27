// Folding-phone awareness (Honor Magic V, Galaxy Z Fold/Flip, Pixel Fold, Surface Duo…).
//
// The hinge position comes from:
//   1. the Android app, which reads it from Jetpack WindowManager and calls window.mkSetFold(),
//   2. the browser's Viewport Segments API (Chrome on foldables), for the website and the PWA.
// It is published as classes and CSS variables on <html>, so the stylesheet can:
//   • book posture (half-open, vertical fold): sidebar in the left pane, page in the right pane,
//   • any vertical fold while unfolded: the task panel fills exactly the right-hand pane,
//   • tabletop (half-open, horizontal fold): content above the fold, panels and dialogs kept off it.

export interface Fold {
  orientation: 'vertical' | 'horizontal';
  /** 'half' = bent (book or tabletop posture); 'flat' = fully open. */
  state: 'flat' | 'half';
  /** True when the fold splits the screen into two areas (always for dual screens, when bent for single folding screens). */
  separating: boolean;
  /** Hinge rectangle in CSS pixels, relative to the page viewport. */
  x: number; y: number; width: number; height: number;
}

let current: Fold | null = null;
const listeners = new Set<(f: Fold | null) => void>();

export function currentFold() { return current; }
export function onFold(fn: (f: Fold | null) => void) { listeners.add(fn); return () => listeners.delete(fn); }

function apply(f: Fold | null) {
  const same = JSON.stringify(f) === JSON.stringify(current);
  current = f;
  const el = document.documentElement;
  el.classList.toggle('fold-v', !!f && f.orientation === 'vertical');
  el.classList.toggle('fold-h', !!f && f.orientation === 'horizontal');
  el.classList.toggle('fold-half', !!f && f.state === 'half');
  // Two panes are worth it only when each side has room for a usable column.
  el.classList.toggle('fold-split', !!f && f.orientation === 'vertical' && (f.state === 'half' || f.separating) && f.x >= 280 && window.innerWidth - f.x - f.width >= 280);
  el.classList.toggle('fold-table', !!f && f.orientation === 'horizontal' && f.state === 'half' && f.y >= 200);
  const set = (k: string, v: number) => el.style.setProperty(k, `${Math.round(v)}px`);
  if (f) { set('--fold-x', f.x); set('--fold-y', f.y); set('--fold-w', f.width); set('--fold-h', f.height); }
  if (!same) listeners.forEach((fn) => fn(f));
}

/** Viewport Segments API: two segments side by side (vertical fold) or stacked (horizontal fold). */
function fromSegments(): Fold | null | undefined {
  const segs = (window as unknown as { viewport?: { segments?: DOMRect[] } }).viewport?.segments;
  if (!segs) return undefined;          // API not available: keep whatever the app told us
  if (segs.length < 2) return null;
  const [a, b] = segs;
  if (Math.abs(a.top - b.top) < 1) return { orientation: 'vertical', state: 'half', separating: true, x: a.right, y: 0, width: Math.max(0, b.left - a.right), height: window.innerHeight };
  return { orientation: 'horizontal', state: 'half', separating: true, x: 0, y: a.bottom, width: window.innerWidth, height: Math.max(0, b.top - a.bottom) };
}

export function initFold() {
  // Called by the Android app on every fold, unfold, rotation or window change.
  (window as unknown as { mkSetFold: (f: Fold | null) => void }).mkSetFold = (f) => apply(f && typeof f === 'object' ? f : null);
  const pending = (window as unknown as { __mkFold?: Fold | null }).__mkFold;
  if (pending !== undefined) apply(pending);
  const seg = () => { const f = fromSegments(); if (f !== undefined) apply(f); };
  seg();
  window.addEventListener('resize', seg);
  (window as unknown as { viewport?: EventTarget }).viewport?.addEventListener?.('segmentchange', seg);
}
