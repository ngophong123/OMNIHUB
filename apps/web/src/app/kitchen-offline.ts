export type OfflineAction = 'START' | 'READY';
export type KitchenItemSnapshot = { id: string; name: string; status: string; ticketId: string; preparationNote?: string };
export type KitchenOrderSnapshot = { id: string; status: string; version: number; createdAt: string; items: KitchenItemSnapshot[]; tickets: { id: string; station: { name: string } }[] };
export type KitchenSnapshot = { key: string; savedAt: string; orders: KitchenOrderSnapshot[] };
export type SyncStatus = 'PENDING' | 'SENDING' | 'CONFIRMED' | 'CONFLICT' | 'REJECTED' | 'BLOCKED' | 'REVIEWED';
export type OfflineKitchenCommand = {
  commandId: string; scope: string; tenantId: string; storeId: string; userId: string; deviceId: string;
  orderId: string; itemId: string; expectedVersion: number; action: OfflineAction; sequence: number;
  createdAt: string; status: SyncStatus; code?: string;
};
export type KitchenScope = { tenantId: string; storeId: string; userId: string };
export type OfflineIdentity = KitchenScope & { role: string; storeName: string };

const DB_NAME = 'omnihub-kitchen-v1';
const scopeKey = (s: KitchenScope) => `${s.tenantId}:${s.storeId}:${s.userId}`;
function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('OFFLINE_STORAGE_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('commands')) {
        const commands = db.createObjectStore('commands', { keyPath: 'commandId' });
        commands.createIndex('scope-sequence', ['scope', 'sequence'], { unique: true });
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('OFFLINE_STORAGE_OPEN_FAILED'));
  });
}
function finish<T>(db: IDBDatabase, tx: IDBTransaction, request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('OFFLINE_STORAGE_REQUEST_FAILED'));
    tx.onabort = () => reject(tx.error ?? new Error('OFFLINE_STORAGE_ABORTED'));
    tx.onerror = () => reject(tx.error ?? new Error('OFFLINE_STORAGE_FAILED'));
    tx.oncomplete = () => db.close();
  });
}
export async function getKitchenDeviceId(scope: KitchenScope): Promise<string> {
  const db = await openDb(); const key = `${scopeKey(scope)}:device`; const tx = db.transaction('meta', 'readwrite'); const store = tx.objectStore('meta');
  return new Promise((resolve, reject) => {
    let deviceId = '';
    const request = store.get(key);
    request.onsuccess = () => { const id = request.result?.value as string | undefined; deviceId = id ?? crypto.randomUUID(); if (!id) store.put({ key, value: deviceId }); };
    request.onerror = () => reject(request.error ?? new Error('OFFLINE_STORAGE_FAILED'));
    tx.oncomplete = () => { db.close(); resolve(deviceId); }; tx.onabort = () => { db.close(); reject(tx.error ?? new Error('OFFLINE_STORAGE_ABORTED')); };
  });
}
export async function saveKitchenSnapshot(scope: KitchenScope, orders: KitchenOrderSnapshot[]): Promise<void> {
  const db = await openDb(); const tx = db.transaction('snapshots', 'readwrite');
  tx.objectStore('snapshots').put({ key: scopeKey(scope), savedAt: new Date().toISOString(), orders } satisfies KitchenSnapshot);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('OFFLINE_STORAGE_FAILED')); }; });
}
export async function readKitchenSnapshot(scope: KitchenScope): Promise<KitchenSnapshot | undefined> {
  const db = await openDb(); const tx = db.transaction('snapshots', 'readonly'); return finish(db, tx, tx.objectStore('snapshots').get(scopeKey(scope)));
}
export async function clearKitchenSnapshot(scope: KitchenScope): Promise<void> {
  const db = await openDb(); const tx = db.transaction('snapshots', 'readwrite'); tx.objectStore('snapshots').delete(scopeKey(scope));
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('OFFLINE_STORAGE_FAILED')); }; });
}
export async function clearKitchenScopeData(scope: KitchenScope): Promise<void> {
  const db = await openDb();
  const keyPrefix = scopeKey(scope);
  const tx = db.transaction(['snapshots', 'commands', 'meta'], 'readwrite');
  tx.objectStore('snapshots').delete(keyPrefix);
  tx.objectStore('meta').delete(`${keyPrefix}:device`);
  tx.objectStore('meta').delete(`${keyPrefix}:sequence`);
  const commandsStore = tx.objectStore('commands');
  const all = await new Promise<OfflineKitchenCommand[]>((resolve, reject) => {
    const req = commandsStore.getAll();
    req.onsuccess = () => resolve(req.result as OfflineKitchenCommand[]);
    req.onerror = () => reject(req.error);
  });
  for (const row of all) {
    if (row.scope === keyPrefix) commandsStore.delete(row.commandId);
  }
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('OFFLINE_STORAGE_FAILED')); }; });
}
export async function pruneKitchenCommands(scope: KitchenScope, keepTerminal = 100): Promise<void> {
  const db = await openDb();
  const keyPrefix = scopeKey(scope);
  const tx = db.transaction('commands', 'readwrite');
  const store = tx.objectStore('commands');
  const rows = await new Promise<OfflineKitchenCommand[]>((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as OfflineKitchenCommand[]);
    req.onerror = () => reject(req.error);
  });
  const terminal = rows
    .filter(row => row.scope === keyPrefix && (row.status === 'CONFIRMED' || row.status === 'REVIEWED'))
    .sort((a, b) => a.sequence - b.sequence);
  const excess = terminal.length - Math.max(0, keepTerminal);
  for (let i = 0; i < excess; i++) {
    store.delete(terminal[i]!.commandId);
  }
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('OFFLINE_STORAGE_FAILED')); }; });
}
export async function rememberKitchenIdentity(identity: OfflineIdentity): Promise<void> {
  const db = await openDb(); const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key: 'last-kitchen-identity', value: identity });
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('OFFLINE_STORAGE_FAILED')); }; });
}
export async function readKitchenIdentity(): Promise<OfflineIdentity | undefined> {
  const db = await openDb(); const tx = db.transaction('meta', 'readonly'); const row = await finish(db, tx, tx.objectStore('meta').get('last-kitchen-identity')) as { value?: OfflineIdentity } | undefined;
  return row?.value;
}
export async function forgetKitchenIdentity(): Promise<void> {
  const db = await openDb(); const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').delete('last-kitchen-identity');
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('OFFLINE_STORAGE_FAILED')); }; });
}
export async function readKitchenCommands(scope: KitchenScope): Promise<OfflineKitchenCommand[]> {
  const db = await openDb(); const tx = db.transaction('commands', 'readonly'); const rows = await finish(db, tx, tx.objectStore('commands').getAll()) as OfflineKitchenCommand[];
  return rows.filter(command => command.scope === scopeKey(scope)).sort((a, b) => a.sequence - b.sequence);
}
export async function recoverKitchenCommands(scope: KitchenScope): Promise<OfflineKitchenCommand[]> {
  const db = await openDb(); const tx = db.transaction('commands', 'readwrite'); const store = tx.objectStore('commands');
  const rows = await new Promise<OfflineKitchenCommand[]>((resolve, reject) => { const request = store.getAll(); request.onsuccess = () => resolve(request.result as OfflineKitchenCommand[]); request.onerror = () => reject(request.error); });
  const scoped = rows.filter(command => command.scope === scopeKey(scope)); for (const row of scoped) if (row.status === 'SENDING') { row.status = 'PENDING'; store.put(row); }
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('OFFLINE_STORAGE_FAILED')); }; });
  return scoped.map(row => row.status === 'SENDING' ? { ...row, status: 'PENDING' as const } : row).sort((a, b) => a.sequence - b.sequence);
}
export async function enqueueKitchenCommand(scope: KitchenScope, deviceId: string, orderId: string, itemId: string, expectedVersion: number, action: OfflineAction): Promise<OfflineKitchenCommand> {
  const db = await openDb(); const tx = db.transaction(['commands', 'meta'], 'readwrite'); const commands = tx.objectStore('commands'); const meta = tx.objectStore('meta'); const seqKey = `${scopeKey(scope)}:sequence`;
  return new Promise((resolve, reject) => {
    let created: OfflineKitchenCommand | undefined;
    const request = meta.get(seqKey); request.onsuccess = () => {
      const sequence = Number(request.result?.value ?? 0) + 1; created = { commandId: crypto.randomUUID(), scope: scopeKey(scope), ...scope, deviceId, orderId, itemId, expectedVersion, action, sequence, createdAt: new Date().toISOString(), status: 'PENDING' };
      meta.put({ key: seqKey, value: sequence }); commands.add(created);
    };
    request.onerror = () => reject(request.error ?? new Error('OFFLINE_STORAGE_FAILED'));
    tx.oncomplete = () => { db.close(); if (created) resolve(created); else reject(new Error('OFFLINE_STORAGE_FAILED')); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('OFFLINE_STORAGE_FAILED')); };
  });
}
export async function updateKitchenCommand(commandId: string, update: Partial<Pick<OfflineKitchenCommand, 'status' | 'code'>>): Promise<void> {
  const db = await openDb(); const tx = db.transaction('commands', 'readwrite'); const store = tx.objectStore('commands');
  const row = await new Promise<OfflineKitchenCommand | undefined>((resolve, reject) => { const request = store.get(commandId); request.onsuccess = () => resolve(request.result as OfflineKitchenCommand | undefined); request.onerror = () => reject(request.error); });
  if (row) store.put({ ...row, ...update });
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('OFFLINE_STORAGE_FAILED')); }; });
}
export async function reviewKitchenCommand(commandId: string): Promise<void> { await updateKitchenCommand(commandId, { status: 'REVIEWED' }); }
