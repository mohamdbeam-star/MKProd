// Client side of the MK Prod sync protocol (see web/worker/index.ts and CloudSync.swift).
// Holds the whole workspace in memory, keeps an encrypted offline copy in IndexedDB, and
// keeps it in step with the server: pull everything after `cursor` (decrypting), merge with
// unsynced local edits field by field, then push changed objects (encrypting).

import { Data, ID, Kind, KINDS, Member, emptyData, iso, uid, Task, Order } from './model';
import {
  Bytes, decryptRecord, encryptRecord, importWorkspaceKey, isEncrypted, newWorkspaceKey, open, openBytes, seal, sealBytes,
  unwrapWorkspaceKey, wrapWorkspaceKey,
} from './crypto';
import { Notice, contractNotices, digestNotices, isoWeek, orderNotices, taskNotices } from './notices';

export interface SessionUser { id: ID; email: string; name: string; color: string; publicKey?: string | null; encPrivateKey?: string | null; emailVerified?: boolean; totpEnabled?: boolean }
export interface Session { user: SessionUser; privateKey: CryptoKey }
export interface WorkspaceInfo { id: ID; name: string; role: string }
export interface TeamMember { id: ID; email: string; name: string; color: string; role: string; publicKey: string | null; hasKey: number; totpEnabled?: number }
export interface Presence { user_id: ID; viewing: string; client: string; last_seen: string }
export interface InboxItem { id: ID; date: string; text: string; target?: string; read: boolean }

// ---------------------------------------------------------------- API

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) { super(message); }
}

/** Same-origin JSON call. The session travels in an HttpOnly cookie; X-MKProd blocks CSRF. */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; bearer?: string } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-MKProd': '1', ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`, json);
  return json as T;
}

// ---------------------------------------------------------------- tiny IndexedDB store

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('mkprod', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((res) => {
    const q = db.transaction('kv').objectStore('kv').get(key);
    q.onsuccess = () => res(q.result as T);
    q.onerror = () => res(undefined);
  });
}
export async function idbSet(key: string, value: unknown) {
  const db = await idb();
  return new Promise<void>((res) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(value, key);
    t.oncomplete = () => res();
    t.onerror = () => res();
  });
}
/** Wipe everything stored for this site (sign-out). */
export async function idbClear() {
  const db = await idb();
  return new Promise<void>((res) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').clear();
    t.oncomplete = () => res();
    t.onerror = () => res();
  });
}

// ---------------------------------------------------------------- canonical JSON & merge

/** Key-sorted JSON so equal objects compare equal as strings. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
type Obj = Record<string, any>;

/** Three-way merge: fields only the remote changed take its value, local edits win per field,
 *  arrays of objects with ids (comments, checklists, items…) merge item by item. */
export function merge3(base: Obj, local: Obj, remote: Obj): Obj {
  const out: Obj = { ...remote };
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const lv = local[k], rv = remote[k], bv = base[k];
    if (Array.isArray(lv) && Array.isArray(rv) && [...lv, ...rv].every((x) => x && typeof x === 'object' && 'id' in x)) {
      out[k] = mergeArrays(Array.isArray(bv) ? bv : [], lv, rv);
    } else if (!same(lv, bv)) {
      if (lv === undefined) delete out[k]; else out[k] = lv;
    }
  }
  return out;
}

function mergeArrays(base: Obj[], local: Obj[], remote: Obj[]): Obj[] {
  const b = new Map(base.map((o) => [String(o.id), o]));
  const l = new Map(local.map((o) => [String(o.id), o]));
  const r = new Map(remote.map((o) => [String(o.id), o]));
  const out: Obj[] = [];
  const seen = new Set<string>();
  for (const item of [...remote, ...local]) {
    const k = String(item.id);
    if (seen.has(k)) continue;
    seen.add(k);
    const lo = l.get(k), ro = r.get(k), inBase = b.has(k);
    if (lo && ro) out.push(merge3(b.get(k) ?? {}, lo, ro));
    else if (lo && !inBase) out.push(lo);
    else if (ro && !inBase) out.push(ro);
  }
  return out;
}

// ---------------------------------------------------------------- engine

type Status = { state: 'idle' | 'syncing' | 'synced' | 'error' | 'offline' | 'locked'; at?: number; error?: string };
type Row = { kind: Kind; id: ID; data?: unknown; deleted: boolean };
type WrappedKey = { version: number; wrapped: string };
interface SyncResponse {
  cursor: number; more: boolean; role: string; keyVersion: number; myKeys: WrappedKey[]
  members: TeamMember[]; presence: Presence[]; records: { kind: Kind; id: ID; deleted: boolean; data: any }[]
}

export class SyncEngine {
  data: Data = emptyData();
  members: Member[] = [];
  team: TeamMember[] = [];
  presence: Presence[] = [];
  inbox: InboxItem[] = [];
  role = 'member';
  keyVersion = 0;
  status: Status = { state: 'idle' };
  viewing = '';
  version = 0;

  private cursor = 0;
  private last = new Map<string, string>();
  /** Workspace keys by version. Raw bytes stay in memory only (needed to share with new members). */
  private keys = new Map<number, { key: CryptoKey; raw: Bytes }>();
  private wrappedMine: WrappedKey[] = [];
  private listeners = new Set<() => void>();
  private timer?: number;
  private debounce?: number;
  private running = false;
  private again = false;
  private loaded = false;
  private forcePushAll = false;

  constructor(public session: Session, public workspace: WorkspaceInfo, private onAuthLost: () => void) {
    this.role = workspace.role;
  }

  get me(): ID { return this.session.user.id; }
  get canWrite() { return this.role !== 'viewer'; }
  get isAdmin() { return this.role === 'owner' || this.role === 'admin'; }
  get encrypted() { return this.keyVersion > 0; }
  private get key() { return `ws:${this.workspace.id}:${this.me}`; }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.version++; this.listeners.forEach((f) => f()); }

  async start() {
    await this.loadCache();
    this.loaded = true;
    this.emit();
    await this.sync();
    const tick = () => {
      this.sync();
      this.timer = window.setTimeout(tick, document.hidden ? 30_000 : 4_000);
    };
    this.timer = window.setTimeout(tick, 4_000);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  stop() {
    clearTimeout(this.timer);
    clearTimeout(this.debounce);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  private onVisible = () => { if (!document.hidden) this.sync(); };

  // ---- encrypted offline cache

  private async loadCache() {
    const saved = await idbGet<{ keyVersion: number; myKeys: WrappedKey[]; blob?: string; plain?: unknown }>(this.key);
    if (!saved) return;
    try {
      await this.unlockKeys(saved.myKeys ?? []);
      let state: any = saved.plain;
      if (saved.blob) {
        const k = this.keys.get(saved.keyVersion);
        if (!k) return;
        state = JSON.parse(new TextDecoder().decode(await open(k.key, saved.blob, `${this.workspace.id}|cache`)));
      }
      if (!state) return;
      this.data = { ...emptyData(), ...state.data };
      this.cursor = state.cursor;
      this.last = new Map(state.last);
      this.inbox = state.inbox ?? [];
      this.members = state.members ?? [];
      this.keyVersion = saved.keyVersion;
    } catch {
      // Unreadable cache (key changed): start fresh from the server.
    }
  }

  private persistTimer?: number;
  private persist() {
    if (!this.loaded) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(async () => {
      const state = { data: this.data, cursor: this.cursor, last: [...this.last], inbox: this.inbox.slice(0, 300), members: this.members };
      const k = this.keys.get(this.keyVersion);
      if (this.keyVersion > 0 && k) {
        const blob = await seal(k.key, new TextEncoder().encode(JSON.stringify(state)), `${this.workspace.id}|cache`);
        idbSet(this.key, { keyVersion: this.keyVersion, myKeys: this.wrappedMine, blob });
      } else if (this.keyVersion === 0) {
        // Workspace not encrypted yet (first sync of a new workspace): encrypted on the next save.
        idbSet(this.key, { keyVersion: 0, myKeys: [], plain: state });
      }
    }, 300);
  }

  // ---- local edits

  list<K extends Kind>(kind: K) { return Object.values(this.data[kind]) as Data[K][string][]; }
  get<K extends Kind>(kind: K, id?: ID | null) { return id ? (this.data[kind][id] as Data[K][string] | undefined) : undefined; }

  put<K extends Kind>(kind: K, obj: Data[K][string]) {
    const o = obj as { id: ID };
    this.data = { ...this.data, [kind]: { ...this.data[kind], [o.id]: obj } };
    this.changed();
  }

  update<K extends Kind>(kind: K, id: ID, fn: (o: Data[K][string]) => Data[K][string] | void) {
    const cur = this.get(kind, id);
    if (!cur) return;
    const copy = structuredClone(cur);
    const next = (fn(copy) ?? copy) as Data[K][string] & { updated?: string };
    if ('updated' in (cur as object)) next.updated = iso();
    this.put(kind, next);
  }

  remove(kind: Kind, id: ID) {
    const { [id]: _, ...rest } = this.data[kind] as Record<ID, unknown>;
    this.data = { ...this.data, [kind]: rest };
    this.changed();
  }

  private changed() {
    this.emit();
    this.persist();
    clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.sync(), 800);
  }

  notify(text: string, target?: string) {
    this.inbox = [{ id: uid(), date: iso(), text, target, read: false }, ...this.inbox];
    this.emit();
    this.persist();
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('MK Prod', { body: text });
  }

  markInboxRead(id?: ID) {
    this.inbox = this.inbox.map((n) => (id && n.id !== id ? n : { ...n, read: true }));
    this.emit();
    this.persist();
  }

  // ---- keys

  private async unlockKeys(mine: WrappedKey[]) {
    for (const w of mine) {
      if (this.keys.has(w.version)) continue;
      try {
        const raw = await unwrapWorkspaceKey(w.wrapped, this.session.privateKey, this.workspace.id, this.me, w.version);
        this.keys.set(w.version, { key: await importWorkspaceKey(raw), raw });
      } catch {
        // Wrapped for an older key pair of ours; a teammate will re-share.
      }
    }
    this.wrappedMine = mine;
  }

  /** Share the current workspace key with members who have a key pair but no copy yet. */
  private async shareKeys() {
    const k = this.keys.get(this.keyVersion);
    if (!k || !this.canWrite) return;
    const needs = this.team.filter((m) => m.publicKey && !m.hasKey && m.id !== this.me);
    if (!needs.length) return;
    const wraps = await Promise.all(needs.map(async (m) => ({ userId: m.id, wrapped: await wrapWorkspaceKey(k.raw, m.publicKey!, this.workspace.id, m.id, this.keyVersion) })));
    await api(`/api/workspaces/${this.workspace.id}/keys`, { body: { version: this.keyVersion, wraps } });
  }

  /** Start a new key version (first encryption, or after removing someone) and re-encrypt everything. */
  async rotateKey() {
    if (!this.isAdmin) throw new Error('Only owners and admins can rotate the encryption key');
    const version = this.keyVersion + 1;
    const { key, raw } = await newWorkspaceKey();
    const recipients = this.team.filter((m) => m.publicKey);
    if (!recipients.some((m) => m.id === this.me)) recipients.push({ id: this.me, publicKey: this.session.user.publicKey ?? null } as TeamMember);
    const wraps = await Promise.all(recipients.filter((m) => m.publicKey).map(async (m) => ({
      userId: m.id, wrapped: await wrapWorkspaceKey(raw, m.publicKey!, this.workspace.id, m.id, version),
    })));
    await api(`/api/workspaces/${this.workspace.id}/keys`, { body: { version, wraps } });
    this.keys.set(version, { key, raw });
    this.keyVersion = version;
    this.forcePushAll = true;
    await this.sync();
  }

  // ---- file attachments (ciphertext only ever leaves the browser)

  /** Encrypts a file with the current workspace key and uploads it. Returns the stored id. */
  async uploadFile(bytes: Bytes): Promise<{ fileId: ID; size: number }> {
    const k = this.keys.get(this.keyVersion);
    if (!k || !this.encrypted) throw new Error('The workspace is not encrypted yet; sync once first.');
    const fileId = uid();
    const sealed = await sealBytes(k.key, bytes, `${this.workspace.id}|file|${fileId}`);
    const res = await fetch(`/api/workspaces/${this.workspace.id}/files/${fileId}`, {
      method: 'PUT', credentials: 'same-origin', body: sealed,
      headers: { 'Content-Type': 'application/octet-stream', 'X-MKProd': '1', 'X-Key-Version': String(this.keyVersion) },
    });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    return { fileId, size: bytes.length };
  }

  async downloadFile(fileId: ID): Promise<Bytes> {
    const res = await fetch(`/api/workspaces/${this.workspace.id}/files/${fileId}`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    const version = Number(res.headers.get('X-Key-Version')) || this.keyVersion;
    const k = this.keys.get(version);
    if (!k) throw new Error('You do not have the key this file was encrypted with yet.');
    return openBytes(k.key, new Uint8Array(await res.arrayBuffer()) as Bytes, `${this.workspace.id}|file|${fileId}`);
  }

  deleteFile(fileId: ID) {
    return api(`/api/workspaces/${this.workspace.id}/files/${fileId}`, { method: 'DELETE' });
  }

  // ---- sync

  async sync() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    if (this.status.state !== 'synced') { this.status = { state: 'syncing' }; this.emit(); }
    try {
      let more = true;
      while (more) more = await this.exchange([]);
      // Encrypt the workspace the first time an owner/admin with a key pair connects.
      if (this.keyVersion === 0 && this.isAdmin && this.session.user.publicKey) {
        this.running = false;
        await this.rotateKey();
        return;
      }
      if (this.encrypted && !this.keys.has(this.keyVersion)) {
        this.status = { state: 'locked', error: 'Waiting for a teammate to share the encryption key with you.' };
        return;
      }
      await this.shareKeys().catch(() => {});
      if (this.canWrite) {
        const previous = new Map(this.last);
        if (this.forcePushAll) { this.last.clear(); this.forcePushAll = false; }
        const rows = await this.dirtyRows();
        const notices = previous.size ? this.emailNotices(rows, previous) : [];
        let batch: Row[] = [];
        let size = 0;
        for (const row of rows) {
          const n = JSON.stringify(row).length;
          if (batch.length && size + n > 1_500_000) { await this.exchange(batch); batch = []; size = 0; }
          batch.push(row);
          size += n;
        }
        if (batch.length) await this.exchange(batch);
        this.sendNotices([...notices, ...this.dueContractNotices(), ...this.dueDigestNotices()]);
      } else {
        this.revertLocalEdits();
      }
      this.status = { state: 'synced', at: Date.now() };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { this.onAuthLost(); return; }
      this.status = { state: navigator.onLine ? 'error' : 'offline', error: (e as Error).message };
    } finally {
      this.running = false;
      this.persist();
      this.emit();
      if (this.again) { this.again = false; setTimeout(() => this.sync(), 200); }
    }
  }

  /** Changed objects, with plaintext kept alongside for `last` bookkeeping. */
  private async dirtyRows(): Promise<(Row & { plain?: string })[]> {
    const rows: (Row & { plain?: string })[] = [];
    const seen = new Set<string>();
    const k = this.keys.get(this.keyVersion);
    for (const kind of KINDS) {
      for (const [id, obj] of Object.entries(this.data[kind])) {
        const key = `${kind}/${id}`;
        seen.add(key);
        const plain = canonical(obj);
        if (this.last.get(key) === plain) continue;
        const data = this.encrypted && k ? await encryptRecord(k.key, this.keyVersion, this.workspace.id, kind, id, obj) : obj;
        rows.push({ kind, id, data, deleted: false, plain });
      }
    }
    for (const key of this.last.keys()) {
      if (seen.has(key)) continue;
      const [kind, id] = key.split('/') as [Kind, ID];
      rows.push({ kind, id, deleted: true });
    }
    return rows;
  }

  private async exchange(push: (Row & { plain?: string })[]): Promise<boolean> {
    const res = await api<SyncResponse>(`/api/workspaces/${this.workspace.id}/sync`, {
      body: { cursor: this.cursor, push: push.map(({ plain, ...r }) => r), viewing: this.viewing, client: 'web' },
    });
    for (const r of push) {
      const key = `${r.kind}/${r.id}`;
      if (r.deleted) this.last.delete(key); else this.last.set(key, r.plain!);
    }
    this.role = res.role;
    this.team = res.members;
    this.members = res.members.map((m) => ({ id: m.id, name: m.name || m.email, email: m.email, colorHex: m.color }));
    this.presence = res.presence;
    if (res.keyVersion !== this.keyVersion && res.keyVersion > this.keyVersion) this.keyVersion = res.keyVersion;
    await this.unlockKeys(res.myKeys);
    if (!(await this.apply(res.records))) return false; // can't decrypt yet: keep the cursor
    this.cursor = Math.max(this.cursor, res.cursor);
    return res.more;
  }

  /** Applies pulled rows. Returns false (applying nothing) if some rows can't be decrypted yet. */
  private async apply(rows: { kind: Kind; id: ID; deleted: boolean; data: any }[]): Promise<boolean> {
    if (!rows.length) return true;
    const plain: { kind: Kind; id: ID; deleted: boolean; data: any }[] = [];
    for (const r of rows) {
      if (!KINDS.includes(r.kind)) continue;
      if (r.deleted || !isEncrypted(r.data)) { plain.push(r); continue; }
      const k = this.keys.get(r.data.v);
      if (!k) {
        if (r.data.v >= this.keyVersion) return false; // current key not shared with us yet: retry later
        console.warn('MK Prod: no key for retired version', r.data.v, r.kind, r.id);
        continue;
      }
      try {
        plain.push({ ...r, data: await decryptRecord(k.key, this.workspace.id, r.kind, r.id, r.data) });
      } catch {
        // Tampered or mis-addressed ciphertext: ignore it rather than corrupt local data.
        console.warn('MK Prod: could not decrypt', r.kind, r.id);
      }
    }
    const data = { ...this.data } as Data;
    const touched = new Set<Kind>();
    const after: (() => void)[] = [];
    for (const r of plain) {
      const key = `${r.kind}/${r.id}`;
      if (!touched.has(r.kind)) { (data as any)[r.kind] = { ...data[r.kind] }; touched.add(r.kind); }
      const coll = data[r.kind] as Record<ID, any>;
      const local = coll[r.id];
      if (r.deleted) { delete coll[r.id]; this.last.delete(key); continue; }
      const remoteStr = canonical(r.data);
      const localStr = local === undefined ? undefined : canonical(local);
      if (remoteStr === localStr) { this.last.set(key, remoteStr); continue; }
      const base = this.last.get(key);
      if (local !== undefined && localStr !== base) {
        coll[r.id] = merge3(base ? JSON.parse(base) : {}, local, r.data);
        this.last.set(key, remoteStr);
        continue;
      }
      if (r.kind === 'tasks') after.push(() => this.notifyTask(local, r.data));
      if (r.kind === 'orders') after.push(() => this.notifyOrder(local, r.data));
      if (r.kind === 'messages' && !local) after.push(() => this.notifyMessage(r.data));
      coll[r.id] = r.data;
      this.last.set(key, remoteStr);
    }
    this.data = data;
    after.forEach((f) => f());
    return true;
  }

  private revertLocalEdits() {
    let changed = false;
    const data = { ...this.data } as Data;
    for (const kind of KINDS) {
      const coll = { ...data[kind] } as Record<ID, any>;
      for (const [id, obj] of Object.entries(coll)) {
        const base = this.last.get(`${kind}/${id}`);
        if (base === undefined) { delete coll[id]; changed = true; } else if (base !== canonical(obj)) { coll[id] = JSON.parse(base); changed = true; }
      }
      (data as any)[kind] = coll;
    }
    if (changed) this.data = data;
  }

  // ---- notifications for teammates' changes

  private firstName() { return (this.session.user.name || '').split(' ')[0]; }
  private nameOf(id: ID) { return this.members.find((m) => m.id === id)?.name ?? 'Someone'; }

  private notifyTask(before: Task | undefined, t: Task) {
    if (t.assigneeIds.includes(this.me) && !before?.assigneeIds.includes(this.me)) this.notify(`You were assigned "${t.title}"`, `task:${t.id}`);
    const old = new Set(before?.comments.map((c) => c.id) ?? []);
    for (const c of t.comments) {
      if (old.has(c.id) || c.authorId === this.me) continue;
      if (c.assigneeId === this.me) this.notify(`${this.nameOf(c.authorId)} assigned you a comment on "${t.title}"`, `task:${t.id}`);
      else if (this.firstName() && c.text.toLowerCase().includes('@' + this.firstName().toLowerCase())) this.notify(`${this.nameOf(c.authorId)} mentioned you on "${t.title}"`, `task:${t.id}`);
      else if (t.assigneeIds.includes(this.me) || t.watcherIds.includes(this.me)) this.notify(`${this.nameOf(c.authorId)} commented on "${t.title}"`, `task:${t.id}`);
    }
  }

  private notifyOrder(before: Order | undefined, o: Order) {
    if (before?.status === o.status && before?.assignedTo === o.assignedTo) return;
    if (before?.status !== o.status) {
      if (this.approvalCheck?.(o)) this.notify(`Order #${o.number} "${o.title}" is waiting for your approval`, `order:${o.id}`);
      else if (o.requestedBy === this.me) this.notify(`Your order #${o.number} "${o.title}" is now ${o.status}`, `order:${o.id}`);
    }
    if (o.assignedTo === this.me && before?.assignedTo !== this.me) this.notify(`Order #${o.number} "${o.title}" was assigned to you`, `order:${o.id}`);
  }

  private notifyMessage(m: { authorId: ID; text: string; channelId: ID }) {
    if (m.authorId !== this.me && this.firstName() && m.text.toLowerCase().includes('@' + this.firstName().toLowerCase())) {
      this.notify(`${this.nameOf(m.authorId)} mentioned you in chat`, `chat:${m.channelId}`);
    }
  }

  /** Set by the finance module so order notifications know who can approve. */
  approvalCheck?: (o: Order, member?: ID) => boolean;

  // ---- email notifications (composed here, relayed by the server)

  private lastContractCheck = 0;

  private emailNotices(rows: (Row & { plain?: string })[], previous: Map<string, string>): Notice[] {
    const out: Notice[] = [];
    for (const r of rows) {
      if (r.deleted || !r.plain) continue;
      const oldRaw = previous.get(`${r.kind}/${r.id}`);
      const before = oldRaw ? JSON.parse(oldRaw) : undefined;
      const now = JSON.parse(r.plain);
      if (r.kind === 'tasks') out.push(...taskNotices(this, before, now));
      if (r.kind === 'orders' && this.approvalCheck) out.push(...orderNotices(this, before, now, (o, m) => this.approvalCheck!(o, m)));
    }
    return out;
  }

  private dueContractNotices(): Notice[] {
    if (Date.now() - this.lastContractCheck < 6 * 3600_000) return [];
    this.lastContractCheck = Date.now();
    return contractNotices(this);
  }

  /** Monday morning (or the first sync after it): one digest per teammate, once per week per browser. */
  private dueDigestNotices(): Notice[] {
    if (!this.approvalCheck) return [];
    const week = isoWeek();
    const key = `mkprod.digest:${this.workspace.id}`;
    try {
      if (localStorage.getItem(key) === week) return [];
      localStorage.setItem(key, week);
    } catch { return []; }
    return digestNotices(this, (o, m) => this.approvalCheck!(o, m));
  }

  private sendNotices(notices: Notice[]) {
    for (let i = 0; i < notices.length; i += 50) {
      api(`/api/workspaces/${this.workspace.id}/notify`, { body: { notices: notices.slice(i, i + 50) } })
        .catch((e) => console.warn('Email notices not sent:', (e as Error).message));
    }
  }
}
