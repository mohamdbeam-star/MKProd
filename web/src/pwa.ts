// Installable-app plumbing: registers the service worker and exposes the browser's
// "install this site as an app" prompt (Edge/Chrome on Windows, Chrome on macOS/Android).
import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export function registerPwa() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}

/** The install action when the browser offers one, otherwise null (already installed, or unsupported browser). */
export function useInstallPrompt(): (() => Promise<void>) | null {
  const available = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => deferred !== null);
  if (!available) return null;
  return async () => {
    const p = deferred;
    if (!p) return;
    await p.prompt();
    const { outcome } = await p.userChoice;
    if (outcome === 'accepted') { deferred = null; notify(); }
  };
}

export const isInstalledApp = () => window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches;
