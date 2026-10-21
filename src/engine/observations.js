// Observation system: a session-only ring buffer or a private application history (IndexedDB).
// Observations are the ORIGINAL observed crops, never enhanced reconstructions. Nothing is written
// to the user's photo folders unless they explicitly export an item.
const DB = 'truevision-observations', STORE = 'obs';

export class ObservationLog extends EventTarget {
  constructor(opts = {}) {
    super();
    this.opts = { mode: 'session', maxItems: 200, retentionDays: 7, ...opts };
    this.items = []; this.nextId = 1; this.db = null;
  }
  async configure(opts) {
    const prevMode = this.opts.mode; Object.assign(this.opts, opts);
    if (this.opts.mode === 'private' && prevMode !== 'private') await this.load();
    if (this.opts.mode !== 'private' && this.db) { this.db.close(); this.db = null; }
    this.prune(); this.emit();
  }
  emit() { this.dispatchEvent(new Event('change')); }

  async openDb() {
    if (this.db || typeof indexedDB === 'undefined') return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    }).catch(() => null);
    return this.db;
  }
  async load() {
    const db = await this.openDb(); if (!db) return;
    const rows = await new Promise((resolve) => { const r = db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => resolve(r.result || []); r.onerror = () => resolve([]); });
    const valid = rows.filter((r) => r && typeof r.id === 'number' && typeof r.t === 'number' && typeof r.kind === 'string');
    for (const r of valid) { r.thumbUrl = r.thumb ? URL.createObjectURL(r.thumb) : null; }
    this.items = valid.sort((a, b) => a.t - b.t);
    this.nextId = this.items.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    this.prune();
  }
  async persist(item) {
    if (this.opts.mode !== 'private') return; const db = await this.openDb(); if (!db) return;
    const { thumbUrl, ...row } = item; // blobs are structured-cloneable
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(row);
  }
  async unpersist(id) { if (!this.db) return; this.db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id); }

  /** Add an observation. `thumb` and `crop` are Blobs of the original observed pixels. */
  async add({ kind, label, source = 'camera 01', thumb = null, crop = null, meta = {} }) {
    const item = { id: this.nextId++, t: Date.now(), kind: String(kind).slice(0, 40), label: String(label).slice(0, 120), source: String(source).slice(0, 60), thumb, crop, meta: sanitizeMeta(meta) };
    item.thumbUrl = thumb ? URL.createObjectURL(thumb) : null;
    this.items.push(item); this.prune(); await this.persist(item); this.emit(); return item;
  }
  prune() {
    const cutoff = Date.now() - this.opts.retentionDays * 86400e3;
    const drop = [];
    this.items = this.items.filter((i) => { const keep = i.t >= cutoff; if (!keep) drop.push(i); return keep; });
    while (this.items.length > this.opts.maxItems) drop.push(this.items.shift());
    for (const d of drop) { if (d.thumbUrl) URL.revokeObjectURL(d.thumbUrl); this.unpersist(d.id); }
  }
  remove(id) { const i = this.items.find((x) => x.id === id); if (!i) return; if (i.thumbUrl) URL.revokeObjectURL(i.thumbUrl); this.items = this.items.filter((x) => x.id !== id); this.unpersist(id); this.emit(); }
  async clear() {
    for (const i of this.items) if (i.thumbUrl) URL.revokeObjectURL(i.thumbUrl);
    this.items = [];
    const db = await this.openDb(); if (db) db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    this.emit();
  }
  get(id) { return this.items.find((x) => x.id === id); }
  stats() { return { count: this.items.length, bytes: this.items.reduce((a, i) => a + (i.thumb?.size || 0) + (i.crop?.size || 0), 0) }; }
}

function sanitizeMeta(m) {
  const out = {};
  for (const [k, v] of Object.entries(m || {})) {
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 1e4) / 1e4;
    else if (typeof v === 'string') out[k] = v.slice(0, 80);
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
