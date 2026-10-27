// Renders the icon variants in icon.mjs to every PNG the apps need, with headless Chromium.
//   node scripts/icon/render.mjs            (needs Playwright: npx playwright or a global install)
// Outputs are committed, so builds don't need a browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { variants } from './icon.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright').then((m) => m.default ?? m);
const browser = await pw.chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function png(variant, size, out) {
  const svg = variants[variant]();
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body></html>`);
  const file = path.join(root, out);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.locator('svg').screenshot({ path: file, omitBackground: true });
  console.log(`${out} (${size}px, ${variant})`);
}

// Masters
fs.writeFileSync(path.join(root, 'scripts/icon/mkprod-icon.svg'), variants.rounded());
await png('mac', 1024, 'scripts/icon/mac-1024.png');            // build_app.sh makes the .icns from this
await png('square', 1024, 'ios/MKProd/Assets.xcassets/AppIcon.appiconset/icon-1024.png');
await png('rounded', 512, 'ios/MKProd/Assets.xcassets/Logo.imageset/logo.png');
// The App Store refuses icons with an alpha channel, even a fully opaque one: flatten to RGB.
execFileSync('python3', ['-c', "import sys;from PIL import Image;p=sys.argv[1];Image.open(p).convert('RGB').save(p)", path.join(root, 'ios/MKProd/Assets.xcassets/AppIcon.appiconset/icon-1024.png')]);

// Website / PWA (also what the Windows and Android apps show inside)
fs.writeFileSync(path.join(root, 'web/public/icon.svg'), variants.rounded());
await png('rounded', 180, 'web/public/icons/icon-180.png');      // iPhone "Add to Home Screen"
await png('square', 180, 'web/public/icons/apple-touch-icon.png');
await png('rounded', 192, 'web/public/icons/icon-192.png');
await png('rounded', 512, 'web/public/icons/icon-512.png');
await png('maskable', 512, 'web/public/icons/maskable-512.png');

// Windows (electron-builder turns this into the .ico)
await png('rounded', 512, 'desktop/build/icon.png');

// Android: adaptive (background + foreground + themed monochrome) and legacy launchers
const res = 'android/app/src/main/res';
await png('adaptiveBackground', 432, `${res}/drawable-nodpi/ic_launcher_background.png`);
await png('adaptiveForeground', 432, `${res}/drawable-nodpi/ic_launcher_foreground.png`);
await png('monochrome', 432, `${res}/drawable-nodpi/ic_launcher_monochrome.png`);
for (const [dpi, px] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
  await png('rounded', px, `${res}/mipmap-${dpi}/ic_launcher.png`);
}

await browser.close();
