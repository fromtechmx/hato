// HATO · almacenamiento local. Una base por usuario para no mezclar datos en teléfonos compartidos.

const STORES = ['animales', 'eventos', 'meta'];
const KEYS = { animales: 'id', eventos: 'id', meta: 'k' };

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openIdbStore(userId) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(`hato_${userId}`, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: KEYS[s] });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
      resolve({
        get: (s, id) => req(tx(s).get(id)),
        all: (s) => req(tx(s).getAll()),
        put: (s, obj) => req(tx(s, 'readwrite').put(obj)),
        putMany: (s, objs) =>
          new Promise((res, rej) => {
            const t = db.transaction(s, 'readwrite');
            const os = t.objectStore(s);
            for (const o of objs) os.put(o);
            t.oncomplete = () => res();
            t.onerror = () => rej(t.error);
            t.onabort = () => rej(t.error);
          }),
        del: (s, id) => req(tx(s, 'readwrite').delete(id)),
        async getMeta(k) { const r = await req(tx('meta').get(k)); return r ? r.v : undefined; },
        async setMeta(k, v) { await req(tx('meta', 'readwrite').put({ k, v })); },
        close: () => db.close(),
      });
    };
  });
}

/** Misma interfaz en memoria: para pruebas. */
export function createMemStore() {
  const data = { animales: new Map(), eventos: new Map(), meta: new Map() };
  const clone = (x) => (x === undefined ? undefined : structuredClone(x));
  return {
    async get(s, id) { return clone(data[s].get(id)); },
    async all(s) { return [...data[s].values()].map(clone); },
    async put(s, o) { data[s].set(o[KEYS[s]], clone(o)); },
    async putMany(s, os) { for (const o of os) data[s].set(o[KEYS[s]], clone(o)); },
    async del(s, id) { data[s].delete(id); },
    async getMeta(k) { return clone(data.meta.get(k)?.v); },
    async setMeta(k, v) { data.meta.set(k, { k, v: clone(v) }); },
    close() {},
  };
}
