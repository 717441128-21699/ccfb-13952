/** IndexedDB 持久化档案库 */
import type { LadleProfile } from '../core/types';
import type { ProfileStore } from '../core/archive';

const DB_NAME = 'ladle-ir-monitor';
const STORE = 'profiles';
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'ladleId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IndexedDbProfileStore implements ProfileStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  async load(ladleId: string): Promise<LadleProfile | null> {
    const db = await this.db();
    const v = await tx(db, 'readonly', (s) => s.get(ladleId) as IDBRequest<LadleProfile | undefined>);
    return v ?? null;
  }

  async save(profile: LadleProfile): Promise<void> {
    const db = await this.db();
    await tx(db, 'readwrite', (s) => s.put(profile));
  }

  async list(): Promise<string[]> {
    const db = await this.db();
    const keys = await tx(db, 'readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>);
    return keys.map(String);
  }
}
