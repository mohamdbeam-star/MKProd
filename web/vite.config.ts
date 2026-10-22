import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = 'mohamdbeam-star/MKProd';

/**
 * Writes dist/apps.json: the download links of the native apps. Their names are fixed by the
 * release workflows, and the versions come from VERSION (Mac, Android) and desktop/package.json
 * (Windows), so the links are known at build time and the server never has to ask GitHub.
 */
function appsManifest(): Plugin {
  return {
    name: 'mkprod-apps-manifest',
    generateBundle() {
      const version = readFileSync(resolve(__dirname, '../VERSION'), 'utf8').trim();
      const winVersion = JSON.parse(readFileSync(resolve(__dirname, '../desktop/package.json'), 'utf8')).version as string;
      const dl = (tag: string, name: string) => ({ name, url: `https://github.com/${REPO}/releases/download/${tag}/${name}` });
      const apps = [
        { platform: 'mac', version, page: `https://github.com/${REPO}/releases/tag/mac-v${version}`, assets: [dl(`mac-v${version}`, `MK-Prod-${version}-mac.dmg`), dl(`mac-v${version}`, `MK-Prod-${version}-mac.zip`)] },
        { platform: 'windows', version: winVersion, page: `https://github.com/${REPO}/releases/tag/windows-v${winVersion}`, assets: [dl(`windows-v${winVersion}`, `MK-Prod-${winVersion}-win-x64.exe`), dl(`windows-v${winVersion}`, `MK-Prod-${winVersion}-portable.exe`)] },
        { platform: 'android', version, page: `https://github.com/${REPO}/releases/tag/android-v${version}`, assets: [dl(`android-v${version}`, `MK-Prod-${version}-android.apk`)] },
      ];
      this.emitFile({ type: 'asset', fileName: 'apps.json', source: JSON.stringify({ apps, releases: `https://github.com/${REPO}/releases` }, null, 2) });
    },
  };
}

export default defineConfig({
  plugins: [react(), appsManifest()],
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
