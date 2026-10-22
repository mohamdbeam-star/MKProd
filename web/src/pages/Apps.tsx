// Download page for the native apps (signed-in people only; the whole shell is behind sign-in).
import { useEffect, useState } from 'react';
import { api } from '../sync';
import { isInstalledApp, useInstallPrompt } from '../pwa';
import { APP_BUILD, APP_VERSION } from '../version';

interface AppInfo { platform: string; version: string | null; publishedAt?: string; page?: string; assets?: { name: string; url: string; size?: number }[] }

const META: Record<string, { title: string; icon: string; pick: (a: { name: string }) => number; note: string }> = {
  mac: { title: 'Mac', icon: '🍎', pick: (a) => (a.name.endsWith('.dmg') ? 0 : 1), note: 'Open the .dmg and drag MK Prod to Applications. First launch: System Settings → Privacy & Security → Open Anyway (once). macOS 14 or newer; Liquid Glass design on macOS 26.' },
  windows: { title: 'Windows', icon: '🪟', pick: (a) => (a.name.includes('portable') ? 1 : 0), note: 'Setup installs for your user only (no admin rights). SmartScreen may say "Windows protected your PC" the first time: More info → Run anyway. The portable .exe needs no installation.' },
  android: { title: 'Android', icon: '🤖', pick: () => 0, note: 'Download on the phone and open the .apk; allow installs from your browser when asked, and choose "Install anyway" if Play Protect warns. Android 7 or newer, phones, tablets and foldables.' },
};
const fmt = (n?: number) => (n === undefined ? '' : n > 1048576 ? `${(n / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB` : `${Math.round(n / 1024)} KB`);

export function AppsPage() {
  const [data, setData] = useState<{ apps: AppInfo[]; releases: string; error?: string } | null>(null);
  const [error, setError] = useState('');
  const install = useInstallPrompt();
  useEffect(() => { api<{ apps: AppInfo[]; releases: string; error?: string }>('/api/apps').then(setData).catch((e) => setError((e as Error).message)); }, []);
  return (
    <div className="col" style={{ gap: 14, maxWidth: 900 }}>
      <div><h1>Get the apps</h1><div className="muted">Same workspace, same account, every feature. Sign in with your usual email and password; two-factor and your recovery code work everywhere.</div>
        <div className="small muted" style={{ marginTop: 6 }}>You are on version {APP_VERSION} (build {APP_BUILD}). The website, Windows and Android apps update themselves: when a newer version is live, a bar at the top offers "Update now". The Mac app is updated by installing the newest release below.</div></div>
      {error && <div className="red small">{error}</div>}
      <div className="grid g3">
        {(data?.apps ?? (['mac', 'windows', 'android'].map((platform) => ({ platform, version: null })) as AppInfo[])).map((a) => {
          const m = META[a.platform];
          const assets = [...(a.assets ?? [])].sort((x, y) => m.pick(x) - m.pick(y));
          return (
            <div key={a.platform} className="card col" style={{ gap: 8 }}>
              <div className="row"><span style={{ fontSize: 28 }}>{m.icon}</span><div><h3>{m.title}</h3><div className="small muted">{a.version ? `Version ${a.version}` : data ? 'Not published yet' : 'Loading…'}{a.publishedAt ? ` · ${new Date(a.publishedAt).toLocaleDateString()}` : ''}</div></div></div>
              {assets.map((f, i) => (
                <a key={f.name} className={`btn ${i === 0 ? 'primary' : ''}`} href={f.url} style={{ justifyContent: 'space-between' }}>
                  <span>{i === 0 ? '⬇ Download' : f.name.includes('portable') ? '⬇ Portable version' : `⬇ ${f.name.split('.').pop()?.toUpperCase()}`}</span><span className="small" style={{ opacity: 0.8 }}>{fmt(f.size)}</span>
                </a>
              ))}
              <p className="small muted" style={{ margin: 0 }}>{m.note}</p>
            </div>
          );
        })}
      </div>
      <div className="card col">
        <h3>This browser</h3>
        {isInstalledApp()
          ? <p className="small muted">You're already using MK Prod as an installed app on this device.</p>
          : install
            ? <div className="row wrap"><button className="btn primary" onClick={() => install()}>⬇ Install as an app</button><span className="small muted">Own window, Start-menu / Dock icon, works offline. No admin rights.</span></div>
            : <p className="small muted">In Edge or Chrome, use the browser menu → <strong>Install MK Prod</strong> (or the install icon in the address bar) to add it as an app. On iPhone/iPad: Safari → Share → Add to Home Screen.</p>}
      </div>
      {data?.releases && <p className="small muted">All versions and release notes: <a href={data.releases} target="_blank" rel="noopener noreferrer">{data.releases}</a></p>}
    </div>
  );
}
