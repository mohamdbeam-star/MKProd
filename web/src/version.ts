// Version of the running web app and a watcher that notices when a newer build has been
// deployed. The Windows and Android apps are thin shells around this site, so this is how every
// platform picks up an update: the page checks /version.json now and then and offers a reload.
import { useEffect, useState } from 'react';

export const APP_VERSION: string = __APP_VERSION__;
export const APP_BUILD: string = __APP_BUILD__;

const CHECK_EVERY = 10 * 60_000;

async function latestBuild(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as { build?: string };
    return typeof j.build === 'string' ? j.build : null;
  } catch { return null; }
}

/** The newer version string once a newer build is live, otherwise null. */
export function useUpdateAvailable(): string | null {
  const [newer, setNewer] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const check = async () => {
      const b = await latestBuild();
      if (stop || !b || b === APP_BUILD) return;
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        const j = (await res.json()) as { version?: string };
        setNewer(j.version ?? 'new');
      } catch { setNewer('new'); }
    };
    const timer = window.setInterval(check, CHECK_EVERY);
    const onVisible = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onVisible);
    const first = window.setTimeout(check, 15_000);
    return () => { stop = true; window.clearInterval(timer); window.clearTimeout(first); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return newer;
}

/** Reloads onto the newest build (also refreshes the service worker's copy of the shell). */
export async function reloadToLatest() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch { /* no service worker: a plain reload is enough */ }
  location.reload();
}
