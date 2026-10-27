// MK Prod app icon, drawn once as SVG and rendered for every platform by render.mjs.
//
// Concept: a glass "foldable" — two panes opening like a book (work on one side, procurement on
// the other, one fold between them, the same way the app spans a folding phone) with a bold check
// sweeping across the fold, and a small gold spark for savings/approvals. Deep indigo → violet →
// magenta gradient, like the app's accent.
//
// Every variant shares one 1024×1024 coordinate system so they line up exactly.

const GLYPH = (s = 1, mono = false) => {
  // The glyph is designed in a 1024 box centred on (512, 512); `s` scales it about the centre.
  const fillL = mono ? '#fff' : 'url(#paneL)', fillR = mono ? '#fff' : 'url(#paneR)';
  const stroke = mono ? '#fff' : 'url(#rim)';
  return `
  <g transform="translate(512 512) scale(${s}) translate(-512 -512)">
    ${mono ? '' : `<ellipse cx="512" cy="792" rx="300" ry="44" fill="#1a0f5c" opacity="0.35" filter="url(#soft)"/>`}
    <!-- left pane, leaning back -->
    <path d="M500 268 L500 760 Q500 776 484 772 L310 700 Q294 694 294 678 L294 318 Q294 302 310 300 L484 254 Q500 252 500 268 Z"
          fill="${fillL}" ${mono ? 'opacity="0.5" mask="url(#cut)"' : ''} stroke="${stroke}" stroke-width="${mono ? 0 : 3}"/>
    <!-- right pane, facing us -->
    <path d="M524 268 L524 760 Q524 776 540 772 L756 716 Q772 712 772 696 L772 300 Q772 284 756 286 L540 254 Q524 252 524 268 Z"
          fill="${fillR}" ${mono ? 'opacity="0.8" mask="url(#cut)"' : ''} stroke="${stroke}" stroke-width="${mono ? 0 : 3}"/>
    ${mono ? '' : `
    <!-- fold highlight -->
    <rect x="503" y="262" width="18" height="512" rx="9" fill="url(#hinge)"/>
    <!-- task lines on the left pane -->
    <g stroke="#ffffff" stroke-linecap="round" opacity="0.55">
      <line x1="336" y1="360" x2="452" y2="336" stroke-width="18"/>
      <line x1="336" y1="424" x2="430" y2="408" stroke-width="18"/>
      <line x1="336" y1="488" x2="446" y2="476" stroke-width="18"/>
    </g>`}
    <!-- the check, crossing the fold -->
    ${mono ? `<mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="#fff"/>
      <path d="M318 548 L452 664 L742 372" fill="none" stroke="#000" stroke-width="130" stroke-linecap="round" stroke-linejoin="round"/></mask>` : ''}
    <path d="M318 548 L452 664 L742 372" fill="none" stroke="#ffffff" stroke-width="82" stroke-linecap="round" stroke-linejoin="round"
          ${mono ? '' : 'filter="url(#glow)"'}/>
    <!-- spark -->
    <path d="M776 206 Q784 250 828 258 Q784 266 776 310 Q768 266 724 258 Q768 250 776 206 Z" fill="${mono ? '#fff' : 'url(#gold)'}"/>
    ${mono ? '' : `<circle cx="776" cy="258" r="10" fill="#fff" opacity="0.9"/>`}
  </g>`;
};

const DEFS = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2B1C93"/>
      <stop offset="0.48" stop-color="#6E4FF2"/>
      <stop offset="1" stop-color="#E2489C"/>
    </linearGradient>
    <radialGradient id="shine" cx="0.22" cy="0.12" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.38"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="warm" cx="0.92" cy="0.95" r="0.6">
      <stop offset="0" stop-color="#FFB86B" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#FFB86B" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="paneL" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.10"/>
    </linearGradient>
    <linearGradient id="paneR" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.16"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.15"/>
    </linearGradient>
    <linearGradient id="hinge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFE7A3"/>
      <stop offset="1" stop-color="#FFB547"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#2a0f6b" flood-opacity="0.45"/>
    </filter>
    <filter id="soft" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="tileShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>`;

const BG = (x = 0, y = 0, w = 1024, h = 1024, r = 0) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#bg)"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#warm)"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#shine)"/>`;

const svg = (body, defs = DEFS) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${defs}${body}</svg>`;

export const variants = {
  /** Full-bleed square (iOS masks it itself; also Android legacy fallback before cropping). */
  square: () => svg(BG() + GLYPH(1.06)),
  /** Rounded tile for the web, Windows and favicons. */
  rounded: () => svg(BG(0, 0, 1024, 1024, 228) + GLYPH(1.04)),
  /** macOS shape: 824px squircle on a 1024 canvas with a soft shadow. */
  mac: () => svg(`<g filter="url(#tileShadow)">${BG(100, 100, 824, 824, 185)}</g>` + GLYPH(0.8)),
  /** Web "maskable": full bleed, glyph inside the 80% safe zone. */
  maskable: () => svg(BG() + GLYPH(0.8)),
  /** Android adaptive layers (108dp canvas; the launcher shows the middle ~72dp). */
  adaptiveBackground: () => svg(BG()),
  adaptiveForeground: () => svg(GLYPH(0.84)),
  /** Android 13 themed icon: single colour, the launcher tints it. */
  monochrome: () => svg(GLYPH(0.84, true), '<defs/>'),
};
