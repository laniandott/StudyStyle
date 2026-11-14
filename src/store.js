/* StudyStyle 模块：src/store.js */

let pouchReadyPromise = null;
function ensurePouchDB() {
  if (window.PouchDB) return Promise.resolve(window.PouchDB);
  if (pouchReadyPromise) return pouchReadyPromise;
  pouchReadyPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './vendor/pouchdb.min.js';
    script.onload = () => window.PouchDB ? resolve(window.PouchDB) : reject(new Error('PouchDB 加载失败'));
    script.onerror = () => { pouchReadyPromise = null; reject(new Error('本地 PouchDB 组件加载失败，请检查服务或刷新页面')); };
    document.head.appendChild(script);
  });
  return pouchReadyPromise;
}

let serverStoreActive = false;
let serverTokenRequired = false;
let tokenPrompted = false;
/* 服务端库版本号：服务端返回的 rev，用于乐观锁；服务端未升级时保持 null（走整库替换兼容路径） */
let serverRev = null;
/* 已知服务端文档基线（_id -> 无 _rev 序列化串），用于增量 delta 同步 */
let serverBaselineKnown = false;
const serverBaselineMap = new Map();
/* 推送去抖与串行队列：同一时间窗内的多次写入合并为一次推送，且避免在途 PUT 未更新 serverRev 前连发引发伪冲突 */
let pushTimer = null;
let pendingPushDocs = null;
const pendingDirtyIds = new Set();
let pushInFlightPromise = null;
let queuedPushDocs = null;
const queuedDirtyIds = new Set();
let queuedForceFull = false;

function loadStoreToken() {
  try { return String(localStorage.getItem(STORE_LOCAL_TOKEN_KEY) || '').trim(); }
  catch { return ''; }
}
function saveStoreToken(token) {
  try {
    const clean = String(token || '').trim();
    if (clean) localStorage.setItem(STORE_LOCAL_TOKEN_KEY, clean);
    else localStorage.removeItem(STORE_LOCAL_TOKEN_KEY);
  } catch {}
}
function serverStoreHeaders(extra = {}) {
  const token = loadStoreToken();
  return token ? { ...extra, 'X-Store-Token': token } : { ...extra };
}
/* PouchDB 传入的 headers 是 Headers 实例，直接对象展开会得到 {}，
   丢掉 Content-Type: application/json 后浏览器改发 text/plain，CouchDB 对 _bulk_docs 等写入直接 415。 */
function mergeFetchHeaders(base, extra = {}) {
  const merged = {};
  if (base) {
    if (typeof base.forEach === 'function' && !Array.isArray(base)) base.forEach((value, key) => { merged[String(key).toLowerCase()] = value; });
    else if (Array.isArray(base)) for (const [key, value] of base) merged[String(key).toLowerCase()] = value;
    else if (typeof base === 'object') for (const [key, value] of Object.entries(base)) merged[String(key).toLowerCase()] = value;
  }
  for (const [key, value] of Object.entries(extra || {})) merged[String(key).toLowerCase()] = value;
  return merged;
}
function docSyncFingerprint(doc) {
  if (!doc || typeof doc !== 'object') return '';
  const { _rev, ...rest } = doc;
  return JSON.stringify(rest);
}
function markBaselineDocs(docs) {
  serverBaselineMap.clear();
  for (const doc of docs || []) {
    if (doc?._id) serverBaselineMap.set(doc._id, docSyncFingerprint(doc));
  }
  serverBaselineKnown = true;
  persistSyncCursor();
}
function updateBaselineDocs(docs) {
  for (const doc of docs || []) {
    if (doc?._id) serverBaselineMap.set(doc._id, docSyncFingerprint(doc));
  }
  serverBaselineKnown = true;
  persistSyncCursor();
}
function applyDeltaDocs(localDocs, deltaDocs) {
  const localById = new Map((localDocs || []).filter(d => d?._id).map(d => [d._id, d]));
  const pushIds = [];
  for (const remoteDoc of deltaDocs || []) {
    if (!remoteDoc?._id) continue;
    const localDoc = localById.get(remoteDoc._id);
    const winner = Domain.pickNewerDoc(localDoc, remoteDoc);
    localById.set(remoteDoc._id, winner);
    if (winner === localDoc && docSyncFingerprint(localDoc) !== docSyncFingerprint(remoteDoc)) {
      pushIds.push(remoteDoc._id);
    }
  }
  return { docs: [...localById.values()], needsPush: pushIds.length > 0, dirtyIds: pushIds };
}

const IDB_NAME = 'studystyle-local-v1';
const IDB_VERSION = 2;
const IDB_STORE = 'kv';
const IDB_DOCS_STORE = 'docs';
const IDB_DOCS_KEY = 'docs';
const IDB_CURSOR_KEY = 'sync_cursor';
const IDB_MIGRATED_KEY = 'studystyle-idb-migrated-v1';

let idbHandle = null;
let idbEnabled = false;
let idbUseDocStore = false;
let idbDocsCache = null;
const idbDocJsonById = new Map();
let idbReadyPromise = null;
let idbWriteQueue = Promise.resolve();
let localStoreTxQueue = Promise.resolve();

function cloneStorageDoc(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (typeof structuredClone === 'function') return structuredClone(doc);
  return JSON.parse(JSON.stringify(doc));
}

function cloneStorageDocs(docs) {
  return Array.isArray(docs) ? docs.map(cloneStorageDoc) : [];
}

function readLegacyLocalStorageDocs() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function handleStorageWriteError(error) {
  const isQuota = error?.name === 'QuotaExceededError' || error?.code === 22 || error?.code === 1014;
  const message = isQuota
    ? '本地存储空间已满，数据未保存。请导出备份后清理部分数据再重试。'
    : '本地保存失败，数据未写入浏览器存储。';
  showToast(message);
  throw new Error(message, { cause: error });
}

function writeLegacyLocalStorageDocs(docs) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(docs));
  } catch (error) {
    handleStorageWriteError(error);
  }
}

function hasIndexedDb() {
  return typeof indexedDB !== 'undefined' && indexedDB && typeof indexedDB.open === 'function';
}

function openIdbDatabase() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(IDB_STORE)) {
          database.createObjectStore(IDB_STORE);
        }
        if (!database.objectStoreNames.contains(IDB_DOCS_STORE)) {
          database.createObjectStore(IDB_DOCS_STORE, { keyPath: '_id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
      req.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞'));
    } catch (error) {
      reject(error);
    }
  });
}

function supportsDocStore(database) {
  try {
    if (!database?.objectStoreNames?.contains?.(IDB_DOCS_STORE)) return false;
    const tx = database.transaction(IDB_DOCS_STORE, 'readonly');
    return typeof tx.objectStore(IDB_DOCS_STORE)?.getAll === 'function';
  } catch {
    return false;
  }
}

function idbReadValue(database, key) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 读取失败'));
  });
}

function idbWriteValue(database, key, value) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 写入失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
  });
}

function idbDeleteKey(database, key) {
  return new Promise(resolve => {
    try {
      const tx = database.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      if (typeof store.delete !== 'function') { resolve(); return; }
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function idbGetAllDocs(database) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(IDB_DOCS_STORE, 'readonly');
    const req = tx.objectStore(IDB_DOCS_STORE).getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error || new Error('IndexedDB 批量读取失败'));
  });
}

function idbApplyDocDiff(database, upserts, deletes) {
  if (!upserts.length && !deletes.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(IDB_DOCS_STORE, 'readwrite');
    const store = tx.objectStore(IDB_DOCS_STORE);
    for (const doc of upserts) store.put(doc);
    for (const id of deletes) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 增量写入失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
  });
}

function persistSyncCursor() {
  if (!idbEnabled || !idbHandle || !serverRev || !serverBaselineKnown) return;
  const snapshot = { rev: serverRev, entries: [...serverBaselineMap.entries()] };
  idbWriteQueue = idbWriteQueue.catch(() => {}).then(() => idbWriteValue(idbHandle, IDB_CURSOR_KEY, snapshot)).catch(() => {});
}

function refreshIdbJsonIndex(docs) {
  idbDocJsonById.clear();
  for (const doc of docs) {
    if (doc?._id) idbDocJsonById.set(doc._id, JSON.stringify(doc));
  }
}

async function ensureLocalStorageBackend() {
  if (!hasIndexedDb()) return false;
  if (idbEnabled && idbHandle) return true;
  if (idbReadyPromise) return idbReadyPromise;
  idbReadyPromise = (async () => {
    try {
      const handle = await openIdbDatabase();
      const useDocStore = supportsDocStore(handle);
      const docStoreList = useDocStore ? await idbGetAllDocs(handle) : [];
      const kvStored = await idbReadValue(handle, IDB_DOCS_KEY);
      const kvList = Array.isArray(kvStored) ? kvStored : [];
      const legacyDocs = readLegacyLocalStorageDocs();

      let initial = docStoreList;
      if (kvList.length > 0) {
        initial = initial.length ? Domain.reconcileDocSets(initial, kvList).docs : kvList;
      }
      if (legacyDocs.length > 0) {
        initial = initial.length ? Domain.reconcileDocSets(initial, legacyDocs).docs : legacyDocs;
      }

      if (useDocStore) {
        if (kvList.length > 0 || legacyDocs.length > 0) {
          await idbApplyDocDiff(handle, initial.filter(d => d?._id), []);
          if (kvList.length > 0) await idbDeleteKey(handle, IDB_DOCS_KEY);
        }
      } else if (legacyDocs.length > 0) {
        await idbWriteValue(handle, IDB_DOCS_KEY, initial);
      }

      if (legacyDocs.length > 0) {
        try {
          localStorage.removeItem(LOCAL_KEY);
          localStorage.setItem(IDB_MIGRATED_KEY, '1');
        } catch {}
      } else {
        try { localStorage.setItem(IDB_MIGRATED_KEY, '1'); } catch {}
      }

      idbHandle = handle;
      idbUseDocStore = useDocStore;
      idbDocsCache = cloneStorageDocs(initial);
      refreshIdbJsonIndex(idbDocsCache);
      idbEnabled = true;

      /* 恢复上次持久化同步游标，保证页面刷新/PWA 冷启动也走 ?since=<rev> 增量同步 */
      try {
        const savedCursor = await idbReadValue(handle, IDB_CURSOR_KEY);
        if (initial.length > 0 && typeof savedCursor?.rev === 'string' && savedCursor.rev && Array.isArray(savedCursor?.entries)) {
          serverRev = savedCursor.rev;
          serverBaselineMap.clear();
          for (const pair of savedCursor.entries) {
            if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
              serverBaselineMap.set(pair[0], pair[1]);
            }
          }
          serverBaselineKnown = true;
        }
      } catch {}

      return true;
    } catch (err) {
      console.warn?.('[StudyStyle] IndexedDB 不可用，已回退 localStorage:', err?.message || err);
      idbEnabled = false;
      idbUseDocStore = false;
      idbHandle = null;
      return false;
    }
  })();
  return idbReadyPromise;
}

function getLocalStorageBackendName() {
  return idbEnabled ? 'indexeddb' : 'localStorage';
}

async function readLocalDocs() {
  await ensureLocalStorageBackend();
  if (idbEnabled && Array.isArray(idbDocsCache)) {
    return cloneStorageDocs(idbDocsCache);
  }
  return readLegacyLocalStorageDocs();
}

function writeLocalDocs(docs) {
  if (idbEnabled && idbHandle) {
    const prevCache = idbDocsCache;
    if (idbUseDocStore) {
      const nextMap = new Map();
      const upserts = [];
      const deletes = [];
      const nextCache = [];
      for (const raw of Array.isArray(docs) ? docs : []) {
        if (!raw?._id) continue;
        const serialized = JSON.stringify(raw);
        if (idbDocJsonById.get(raw._id) !== serialized) {
          const copy = cloneStorageDoc(raw);
          upserts.push(copy);
          nextCache.push(copy);
        } else {
          nextCache.push(raw);
        }
        nextMap.set(raw._id, serialized);
      }
      for (const oldId of idbDocJsonById.keys()) {
        if (!nextMap.has(oldId)) deletes.push(oldId);
      }
      if (!upserts.length && !deletes.length) return Promise.resolve();
      idbDocsCache = nextCache;
      const task = idbWriteQueue.catch(() => {}).then(async () => {
        try {
          await idbApplyDocDiff(idbHandle, upserts, deletes);
          idbDocJsonById.clear();
          for (const [k, v] of nextMap) idbDocJsonById.set(k, v);
        } catch (error) {
          idbDocsCache = prevCache;
          handleStorageWriteError(error);
        }
      });
      idbWriteQueue = task;
      return task;
    }
    const snapshot = cloneStorageDocs(docs);
    idbDocsCache = snapshot;
    const task = idbWriteQueue.catch(() => {}).then(async () => {
      try {
        await idbWriteValue(idbHandle, IDB_DOCS_KEY, snapshot);
      } catch (error) {
        idbDocsCache = prevCache;
        handleStorageWriteError(error);
      }
    });
    idbWriteQueue = task;
    return task;
  }
  writeLegacyLocalStorageDocs(docs);
  return Promise.resolve();
}

function withLocalStoreLock(task) {
  const next = localStoreTxQueue.catch(() => {}).then(task);
  localStoreTxQueue = next;
  return next;
}

/* 立即把待推送数据发出去（页面隐藏、导入完成等关键时机调用），避免防抖窗口内丢同步。
   注意：必须直连 pushServerStoreNow，若改走 pushServerStore 会重新进入防抖，导致关页时数据根本发不出去。 */
function flushServerStore(options = {}) {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  const docs = pendingPushDocs || (options.keepalive ? queuedPushDocs : null);
  pendingPushDocs = null;
  const dirtyIds = options.forceFull ? new Set() : new Set(pendingDirtyIds);
  pendingDirtyIds.clear();
  if (options.forceFull && pushInFlightPromise) queuedForceFull = true;
  if (options.keepalive && queuedPushDocs) {
    if (queuedForceFull || options.forceFull) dirtyIds.clear();
    else for (const id of queuedDirtyIds) dirtyIds.add(id);
    queuedPushDocs = null;
    queuedDirtyIds.clear();
    queuedForceFull = false;
  }
  if (docs) return pushServerStoreNow(docs, dirtyIds.size ? dirtyIds : null, options);
}

function pushServerStore(docs, changedIds = null) {
  if (typeof fetch !== 'function') return;
  pendingPushDocs = docs;
  if (changedIds) {
    const list = changedIds instanceof Set || Array.isArray(changedIds) ? changedIds : [changedIds];
    for (const id of list) { if (id) pendingDirtyIds.add(id); }
  }
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const payload = pendingPushDocs;
    pendingPushDocs = null;
    const dirtyIds = new Set(pendingDirtyIds);
    pendingDirtyIds.clear();
    if (payload) pushServerStoreNow(payload, dirtyIds.size ? dirtyIds : null);
  }, 300);
}
async function executeServerPush(docs, dirtyIds = null, options = {}) {
  if (typeof fetch !== 'function') return;
  try {
    /* 携带 base_rev：服务端版本不一致时走合并而非整库覆盖，避免多设备互相抹除。
       尚未拿到服务端 rev 时先取一次，否则会退化成无条件整库覆盖（架构审计 P0-2）。 */
    if (!serverRev) {
      const initRes = await fetch('/api/store', { cache: 'no-store', headers: serverStoreHeaders() });
      if (initRes.status === 401) {
        serverTokenRequired = true;
        serverStoreActive = false;
        if (!tokenPrompted) { tokenPrompted = true; showToast('服务端需要访问令牌，请在「设置 → 多设备同步」填写 STORE_TOKEN'); }
        return;
      }
      if (initRes.ok) serverTokenRequired = false;
      const initData = initRes.ok ? await initRes.json() : null;
      if (!initData || !initData.rev) return;
      serverRev = initData.rev;
      if (Array.isArray(initData.docs)) markBaselineDocs(initData.docs);
    }
    let body;
    let sentDocs = docs;
    if (serverBaselineKnown && dirtyIds instanceof Set && dirtyIds.size > 0) {
      const deltaDocs = (docs || []).filter(doc => doc?._id && (dirtyIds.has(doc._id) || docSyncFingerprint(doc) !== serverBaselineMap.get(doc._id)));
      if (!deltaDocs.length) return;
      sentDocs = deltaDocs;
      body = { mode: 'delta', docs: deltaDocs, base_rev: serverRev };
    } else {
      body = { docs, base_rev: serverRev };
    }
    const serializedBody = JSON.stringify(body);
    const bodyBytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(serializedBody).length : serializedBody.length * 2;
    const r = await fetch('/api/store', {
      method: 'PUT',
      headers: serverStoreHeaders({ 'Content-Type': 'application/json' }),
      body: serializedBody,
      ...(options.keepalive && bodyBytes <= 60 * 1024 ? { keepalive: true } : {})
    });
    if (r.status === 401) {
      serverTokenRequired = true;
      serverStoreActive = false;
      if (!tokenPrompted) { tokenPrompted = true; showToast('服务端需要访问令牌，请在「设置 → 多设备同步」填写 STORE_TOKEN'); }
      return;
    }
    if (!r.ok) return;
    serverTokenRequired = false;
    serverStoreActive = true;
    const data = await r.json();
    if (!data) return;
    if (data.rev) serverRev = data.rev;
    if (!data.merged) {
      updateBaselineDocs(sentDocs);
      return;
    }
    if (data.mode === 'delta' && Array.isArray(data.changes)) {
      const reconciled = await withLocalStoreLock(async () => {
        const localDocs = await readLocalDocs();
        const res = applyDeltaDocs(localDocs, data.changes);
        await writeLocalDocs(res.docs);
        return res;
      });
      updateBaselineDocs(sentDocs);
      updateBaselineDocs(data.changes);
      if (pouchMode) await applyServerDocsToPouch(pickDocsByIds(reconciled.docs, data.changes));
      showToast('已与服务器同步，合并了其他设备的更新');
      if (reconciled.needsPush) pushServerStore(reconciled.docs, reconciled.dirtyIds);
      await render();
      return;
    }
    /* 服务端返回合并结果时在本地写锁内与最新本地状态合并，避免覆盖并发编辑 */
    if (Array.isArray(data.docs)) {
      const reconciled = await withLocalStoreLock(async () => {
        const localDocs = await readLocalDocs();
        const res = Domain.reconcileDocSets(localDocs, data.docs);
        await writeLocalDocs(res.docs);
        return res;
      });
      markBaselineDocs(data.docs);
      if (pouchMode) await applyServerDocsToPouch(pickDocsByIds(reconciled.docs, data.docs));
      showToast('已与服务器同步，合并了其他设备的更新');
      if (reconciled.needsPush) {
        const pushSet = reconciled.docs.filter(d => d?._id && docSyncFingerprint(d) !== serverBaselineMap.get(d._id)).map(d => d._id);
        pushServerStore(reconciled.docs, pushSet);
      }
      await render();
    }
  } catch {}
}

function pushServerStoreNow(docs, dirtyIds = null, options = {}) {
  if (typeof fetch !== 'function') return;
  if (!options.keepalive && pushInFlightPromise) {
    queuedPushDocs = docs;
    if (!dirtyIds || !(dirtyIds instanceof Set) || dirtyIds.size === 0) queuedForceFull = true;
    else for (const id of dirtyIds) queuedDirtyIds.add(id);
    return pushInFlightPromise;
  }
  const run = executeServerPush(docs, dirtyIds, options);
  if (options.keepalive) return run;
  const wrapped = run.finally(() => {
    if (pushInFlightPromise === wrapped) pushInFlightPromise = null;
    if (queuedPushDocs) {
      const nextDocs = queuedPushDocs;
      const nextDirty = (!queuedForceFull && queuedDirtyIds.size) ? new Set(queuedDirtyIds) : null;
      queuedPushDocs = null;
      queuedDirtyIds.clear();
      queuedForceFull = false;
      void pushServerStoreNow(nextDocs, nextDirty);
    }
  });
  pushInFlightPromise = wrapped;
  return wrapped;
}

async function hydrateFromServerStore(options = {}) {
  if (typeof fetch !== 'function') return { changed: false };
  try {
    const localBefore = await readLocalDocs();
    const canIncremental = Boolean(options.incremental && serverRev && serverBaselineKnown && !options.forceFull && localBefore.length > 0);
    const query = canIncremental ? `?since=${encodeURIComponent(serverRev)}` : '';
    const res = await fetch(`/api/store${query}`, { cache: 'no-store', headers: serverStoreHeaders() });
    if (res.status === 401) {
      serverTokenRequired = true;
      serverStoreActive = false;
      if (!tokenPrompted) {
        tokenPrompted = true;
        showToast('服务端已启用 STORE_TOKEN 鉴权，请前往「设置 → 多设备同步」填写访问令牌');
      }
      return { changed: false };
    }
    if (!res.ok) return { changed: false };
    serverTokenRequired = false;
    const data = await res.json();
    serverStoreActive = true;
    /* 记录服务端版本号，后续推送带上 base_rev 走乐观锁 */
    if (data?.rev) serverRev = data.rev;
    return await withLocalStoreLock(async () => {
      const localDocs = await readLocalDocs();
      if (data?.incremental) {
        if (data.unchanged) {
          const offlineDirty = localDocs.filter(d => d?._id && docSyncFingerprint(d) !== serverBaselineMap.get(d._id)).map(d => d._id);
          if (offlineDirty.length) pushServerStore(localDocs, offlineDirty);
          persistSyncCursor();
          return { changed: false };
        }
        const changes = Array.isArray(data.changes) ? data.changes : [];
        const beforeFingerprints = new Map(localDocs.filter(d => d?._id).map(d => [d._id, docSyncFingerprint(d)]));
        const reconciled = changes.length ? applyDeltaDocs(localDocs, changes) : { docs: localDocs, needsPush: false, dirtyIds: [] };
        let changed = false;
        if (changes.length) {
          await writeLocalDocs(reconciled.docs);
          changed = reconciled.docs.length !== localDocs.length || reconciled.docs.some(d => d?._id && beforeFingerprints.get(d._id) !== docSyncFingerprint(d));
        }
        updateBaselineDocs(changes);
        if (changes.length && pouchMode) {
          const applied = await applyServerDocsToPouch(pickDocsByIds(reconciled.docs, changes));
          if (applied) changed = true;
        }
        const offlineDirty = reconciled.docs.filter(d => d?._id && docSyncFingerprint(d) !== serverBaselineMap.get(d._id)).map(d => d._id);
        const pushSet = [...new Set([...(reconciled.dirtyIds || []), ...offlineDirty])];
        if (pushSet.length) pushServerStore(reconciled.docs, pushSet);
        return { changed };
      }
      const remoteDocs = Array.isArray(data?.docs) ? data.docs : [];
      markBaselineDocs(remoteDocs);
      if (remoteDocs.length === 0 && localDocs.length > 0) {
        pushServerStore(localDocs, localDocs.map(d => d._id));
        return { changed: false };
      }
      if (remoteDocs.length > 0) {
        /* 与服务端共用仲裁规则，墓碑始终代表删除意图。 */
        const beforeFingerprints = new Map(localDocs.filter(d => d?._id).map(d => [d._id, docSyncFingerprint(d)]));
        const reconciled = Domain.reconcileDocSets(localDocs, remoteDocs);
        await writeLocalDocs(reconciled.docs);
        let changed = reconciled.docs.length !== localDocs.length || reconciled.docs.some(d => d?._id && beforeFingerprints.get(d._id) !== docSyncFingerprint(d));
        if (pouchMode) {
          const applied = await applyServerDocsToPouch(pickDocsByIds(reconciled.docs, remoteDocs));
          if (applied) changed = true;
        }
        if (reconciled.needsPush) {
          const pushSet = reconciled.docs.filter(d => d?._id && docSyncFingerprint(d) !== serverBaselineMap.get(d._id)).map(d => d._id);
          pushServerStore(reconciled.docs, pushSet);
        }
        return { changed };
      }
      return { changed: false };
    });
  } catch {
    return { changed: false };
  }
}

function createLocalStore() {
  /* 统一版本号：与 PouchDB 的 <数字>-<hash> 格式兼容，同毫秒内多次写入也不会撞号 */
  let revCounter = 0;
  const nextRev = () => `${++revCounter}-${Math.random().toString(16).slice(2, 10)}`;
  /* _id 会进入 HTML 属性（data-review-card 等），在存储层统一限定字符集，
     使所有写入路径自动免疫属性注入，不必依赖每个调用点自觉转义。 */
  const SAFE_ID = /^[A-Za-z0-9:._-]{1,128}$/;
  return {
    async allDocs() { const docs = await readLocalDocs(); return { rows: docs.map(doc => ({ doc })) }; },
    async get(id) { const docs = await readLocalDocs(); const doc = docs.find(item => item._id === id && !item._deleted); if (!doc) throw { status: 404 }; return doc; },
    async put(doc) {
      return withLocalStoreLock(async () => {
        if (!SAFE_ID.test(String(doc?._id || ''))) throw new Error('非法的文档 _id');
        const docs = await readLocalDocs();
        const old = docs.findIndex(item => item._id === doc._id);
        doc._rev = nextRev(); doc.updated_at = new Date().toISOString();
        if (old < 0) docs.push(doc); else docs[old] = doc;
        await writeLocalDocs(docs);
        pushServerStore(docs, [doc._id]);
        return { ok: true, id: doc._id };
      });
    },
    /* 删除写墓碑而非直接抹除：全量同步模型下「直接删除」会被服务端旧副本复活，
       墓碑让删除意图也能传播到其它设备（架构审计 P0-1）。 */
    async remove(doc) {
      return withLocalStoreLock(async () => {
        if (!SAFE_ID.test(String(doc?._id || ''))) throw new Error('非法的文档 _id');
        const docs = await readLocalDocs();
        const rest = docs.filter(item => item._id !== doc._id);
        const tombstone = { _id: doc._id, _deleted: true, _rev: nextRev(), updated_at: new Date().toISOString(), deleted_at: new Date().toISOString() };
        rest.push(tombstone);
        await writeLocalDocs(rest);
        pushServerStore(rest, [doc._id]);
        return { ok: true };
      });
    },
    /* 批量写入：本地逐条落盘，但只在循环结束后推送一次，避免 N 次全量 PUT */
    async bulkDocs(docs) {
      return withLocalStoreLock(async () => {
        const all = await readLocalDocs();
        const changedIds = [];
        const now = new Date().toISOString();
        for (const doc of docs) {
          if (!SAFE_ID.test(String(doc?._id || ''))) throw new Error('非法的文档 _id');
          const old = all.findIndex(item => item._id === doc._id);
          if (doc._deleted) {
            const tombstone = { _id: doc._id, _deleted: true, _rev: nextRev(), updated_at: now, deleted_at: doc.deleted_at || now };
            if (old < 0) all.push(tombstone); else all[old] = tombstone;
          } else {
            doc._rev = nextRev(); doc.updated_at = now;
            if (old < 0) all.push(doc); else all[old] = doc;
          }
          changedIds.push(doc._id);
        }
        await writeLocalDocs(all);
        pushServerStore(all, changedIds);
        return [];
      });
    }
  };
}

db = createLocalStore();

function applyTheme(theme = 'light') {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = normalized;
  $('#themeColorMeta')?.setAttribute?.('content', normalized === 'dark' ? '#0D1020' : '#EEF0FF');
  const btn = $('#themeToggleButton');
  if (btn) {
    btn.innerHTML = icon(normalized === 'dark' ? 'sun' : 'moon', 'icon icon-20');
    btn.title = normalized === 'dark' ? '切换为浅色外观' : '切换为深色外观';
    btn.setAttribute?.('aria-label', normalized === 'dark' ? '切换为浅色外观' : '切换为深色外观');
  }
}

function isStandalonePwa() {
  return Boolean(
    (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)')?.matches) ||
    (typeof navigator !== 'undefined' && navigator.standalone === true)
  );
}

function isPwaSecureContext() {
  if (typeof location === 'undefined') return false;
  return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

function updateInstallControls() {
  const menuBtn = $('#pwaInstallMenuBtn');
  if (menuBtn) menuBtn.classList.toggle('hidden', !(deferredInstallPrompt && !isStandalonePwa()));
}

async function installPwaApp() {
  if (!deferredInstallPrompt) {
    showToast('请在浏览器菜单或分享面板中选择「添加到主屏幕」');
    return;
  }
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  updateInstallControls();
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice?.outcome === 'accepted') showToast('正在将 StudyStyle 安装到设备');
  } catch (err) {
    console.error(err);
  }
  if (view === 'settings') await render();
}

async function registerPwaServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !isPwaSecureContext()) return null;
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return swRegistration;
  } catch (err) {
    console.error('SW registration failed:', err);
    return null;
  }
}

async function refreshPwaOfflineCache() {
  if (!swRegistration) swRegistration = await registerPwaServiceWorker();
  if (!swRegistration) {
    showToast(isPwaSecureContext() ? '当前环境不支持离线缓存组件' : '请通过 HTTPS 或 localhost 访问以启用离线缓存');
    return;
  }
  try {
    await swRegistration.update();
    if (swRegistration.waiting) swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    showToast('已检查并刷新离线应用缓存');
    if (view === 'settings') await render();
  } catch (err) {
    showToast(`刷新缓存失败：${err.message || err}`);
  }
}

async function toggleTheme() {
  const settings = (await getSetting()) || {};
  const next = settings.theme === 'dark' ? 'light' : 'dark';
  await saveSetting({ ...settings, theme: next });
  applyTheme(next);
  if (view === 'settings') await render();
  showToast(next === 'dark' ? '已切换至深色外观' : '已切换至浅色外观');
}

async function initStore() {
  if (!db) db = createLocalStore();
  pouchMode = false;
  await ensureLocalStorageBackend();
  if (typeof location !== 'undefined' && location.search && typeof URLSearchParams !== 'undefined') {
    const reqView = new URLSearchParams(location.search).get('view');
    if (['today', 'library', 'history', 'settings'].includes(reqView)) view = reqView;
  }
  void registerPwaServiceWorker();
  updateInstallControls();
  await hydrateFromServerStore({ incremental: Boolean(serverRev && serverBaselineKnown) });
  let settings = await getSetting();
  if (!settings) {
    await saveSetting({
      interval_days: INTERVALS,
      interval_preset: 'balanced',
      hold_interval_below_score: 60,
      default_low_action: 'hold',
      /* 高分跳级默认关闭：计划 §6 明确将自适应记忆算法列为首版范围外，需用户主动开启 */
      adaptive_leap: false,
      scheduler_mode: 'adaptive',
      daily_review_limit: 25,
      study_method: 'blurting',
      theme: 'light'
    });
    settings = await getSetting();
  }
  activeStudyMethod = settings?.study_method || 'blurting';
  applyTheme(settings?.theme || 'light');
  await render();
  void resumeSavedCouchSync();
}

/* 墓碑（_deleted）是删除意图的传播载体，对业务读取一律透明过滤 */
async function allDocs() { const result = await db.allDocs({ include_docs: true }); return result.rows.map(row => row.doc).filter(doc => doc && !doc._deleted); }
async function getCards() { return (await allDocs()).filter(doc => doc.type === 'card' && !doc.archived_at); }
async function getReviews() { return (await allDocs()).filter(doc => doc.type === 'review').sort((a, b) => String(b.reviewed_at || '').localeCompare(String(a.reviewed_at || ''))); }
async function getSetting() { try { return await db.get('settings:main'); } catch { return null; } }
async function saveSetting(settings) { const previous = await getSetting(); return db.put({ ...(previous || {}), ...settings, _id: 'settings:main', type: 'settings' }); }
const normalizeTags = raw => {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/[,，]/) : []);
  return [...new Set(list.map(t => (typeof t === 'string' || (typeof t === 'number' && Number.isFinite(t))) ? String(t).trim() : '').filter(Boolean))];
};
const cardTags = card => normalizeTags(card?.tags);
const cardNotebook = card => Domain.normalizeNotebook(card?.notebook);
const filterByNotebook = (cards, nb = activeNotebookFilter) => nb == null ? cards : cards.filter(c => cardNotebook(c) === nb);

function notebookChipHtml(nbName, notebooks = []) {
  const norm = Domain.normalizeNotebook(nbName);
  const found = notebooks.find(n => n.name === norm);
  const color = found?.color || 'indigo';
  return `<button type="button" class="notebook-chip nb-color-${color}" data-notebook-filter="${escapeHtml(norm)}" title="切换到科目笔记本：${escapeHtml(norm)}">${icon('book')}<span>${escapeHtml(norm)}</span></button>`;
}

function notebookShelfHtml(notebooks, allCardsCount, allDueCount) {
  const allBtn = `<button type="button" class="notebook-pill ${activeNotebookFilter == null ? 'active' : ''}" data-notebook-filter="all">${icon('book')}<span>全部科目</span><span class="count-pill">${allCardsCount}</span></button>`;
  const nbBtns = notebooks.map(nb => `<button type="button" class="notebook-pill ${activeNotebookFilter === nb.name ? 'active' : ''}" data-notebook-filter="${escapeHtml(nb.name)}"><i class="nb-dot nb-color-${nb.color}"></i><span>${escapeHtml(nb.name)}</span><span class="count-pill">${nb.due > 0 ? `${nb.due}待` : nb.total}</span></button>`).join('');
  const manageBtn = activeNotebookFilter != null
    ? `<button type="button" class="notebook-pill notebook-manage-pill" data-edit-notebook="${escapeHtml(activeNotebookFilter)}" title="重命名或管理当前笔记本">${icon('edit')}管理本子</button>`
    : '';
  const addBtn = `<button type="button" class="notebook-pill notebook-add-pill" data-action="open-notebook-dialog" title="新建或管理科目笔记本">${icon('plus')}新建科目本</button>`;
  return `<div class="notebook-shelf" role="group" aria-label="科目笔记本切换">${allBtn}${nbBtns}${manageBtn}${addBtn}</div>`;
}

async function saveCard(data) {
  const current = data.id ? await db.get(data.id) : null;
  const settings = await getSetting();
  const intervals = settings?.interval_days || INTERVALS;
  const day = localDay();
  const dueDate = data.due_date && /^\d{4}-\d{2}-\d{2}$/.test(data.due_date) ? data.due_date : (current?.due_date || addDays(day, intervals[0]));
  const nbName = Domain.normalizeNotebook(data.notebook ?? current?.notebook ?? activeNotebookFilter ?? Domain.DEFAULT_NOTEBOOK);
  const savedNbs = Array.isArray(settings?.notebooks) ? [...settings.notebooks] : [];
  if (!savedNbs.some(item => (typeof item === 'string' ? item : item?.name) === nbName)) {
    const color = Domain.NOTEBOOK_COLORS[savedNbs.length % Domain.NOTEBOOK_COLORS.length];
    savedNbs.push({ name: nbName, color });
    await saveSetting({ ...(settings || {}), notebooks: savedNbs });
  }
  const doc = { ...(current || {}), _id: current?._id || `card:${uuid()}`, type: 'card', title: data.title.trim(), outline: data.outline.trim(), tags: normalizeTags(data.tags), notebook: nbName, created_at: current?.created_at || new Date().toISOString(), archived_at: null, interval_index: current?.interval_index ?? 0, due_date: dueDate, last_reviewed_at: current?.last_reviewed_at || null, latest_memory_score: current?.latest_memory_score ?? null };
  return db.put(doc);
}
async function archiveCard(id, restore = false) { const doc = await db.get(id); doc.archived_at = restore ? null : new Date().toISOString(); await db.put(doc); }
async function deleteCard(id) {
  const doc = await db.get(id);
  const reviews = (await getReviews()).filter(row => row.card_id === id);
  const now = new Date().toISOString();
  const tombstones = [doc, ...reviews].map(item => ({ _id: item._id, _rev: item._rev, _deleted: true, updated_at: now, deleted_at: now }));
  await db.bulkDocs(tombstones);
}
async function dueCards(respectNotebook = true) {
  const today = localDay();
  const all = (await getCards()).filter(card => card.due_date <= today);
  return Domain.sortDueCards(respectNotebook ? filterByNotebook(all) : all);
}
async function snoozeDue() {
  const due = await dueCards();
  if (!due.length) return;
  const answer = await askConfirm('顺延未完成卡片', `将 ${due.length} 张今日到期或逾期卡片顺延到明天？`, '顺延到明天');
  if (!answer) return;
  const tomorrow = addDays(localDay(), 1);
  await db.bulkDocs(due.map(card => ({ ...card, due_date: tomorrow })));
  showToast(`${due.length} 张卡片已顺延至明天`);
  await render();
}
function askConfirm(title, message, action) { return new Promise(resolve => { const dialog = $('#confirmDialog'); $('#confirmTitle').textContent = title; $('#confirmMessage').textContent = message; $('#confirmAction').textContent = action; dialog.returnValue = ''; dialog.showModal(); dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); }); }
async function exportData() { const docs = (await allDocs()).map(({ _rev, ...doc }) => { if (doc.type === 'settings') delete doc.couch; return doc; }); const payload = { app: 'StudyStyle', version: 1, exported_at: new Date().toISOString(), docs }; const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `studystyle-backup-${localDay()}.json`; link.click(); URL.revokeObjectURL(link.href); showToast('JSON 备份已导出'); }
function hasUnsafeOwnKeys(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => hasUnsafeOwnKeys(item));
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
    if (hasUnsafeOwnKeys(value[key])) return true;
  }
  return false;
}
async function importData(file) {
  try {
    const payload = JSON.parse(await file.text());
    const docs = Array.isArray(payload) ? payload : payload.docs;
    if (!Array.isArray(docs)) throw new Error('文件格式无效');
    /* 逐条校验并修复：缺标题/大纲的卡片直接丢弃，脏分数归零，避免导入后卡片在库中「凭空消失」 */
    const existingSnapshot = await db.allDocs({ include_docs: true });
    const existingDocsById = new Map(
      (existingSnapshot?.rows || [])
        .filter(row => row?.doc?._id && !row.doc._deleted)
        .map(row => [row.doc._id, row.doc])
    );
    const importMap = new Map();
    let skipped = 0;
    let repaired = 0;
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object' || doc._deleted || hasUnsafeOwnKeys(doc) || !['card', 'review', 'settings'].includes(doc.type)) { skipped++; continue; }
      if (!doc._id) { skipped++; continue; }
      /* _id 会进入 HTML 属性，限定字符集杜绝属性注入（与服务端校验保持一致） */
      if (!/^[A-Za-z0-9:._-]{1,128}$/.test(String(doc._id))) { skipped++; continue; }
      const { _rev, ...clean } = doc;
      const existingDoc = existingDocsById.get(clean._id);
      if (clean.type === 'card') {
        if (typeof clean.title !== 'string' || !clean.title.trim() || typeof clean.outline !== 'string' || !clean.outline.trim()) { skipped++; continue; }
        clean.title = clean.title.trim();
        clean.outline = clean.outline.trim();
        clean.tags = normalizeTags(clean.tags);
        if (clean.latest_memory_score != null) {
          const score = Number(clean.latest_memory_score);
          if (!Number.isFinite(score) || score < 0 || score > 100) { clean.latest_memory_score = null; repaired++; }
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(clean.due_date || ''))) clean.due_date = addDays(localDay(), 1);
      } else if (clean.type === 'review') {
        if (typeof clean.card_id !== 'string' || !clean.card_id || !Number.isFinite(Date.parse(clean.reviewed_at || ''))) { skipped++; continue; }
        const score = Number(clean.memory_score);
        if (!Number.isFinite(score) || score < 0 || score > 100) { clean.memory_score = null; repaired++; }
        else clean.memory_score = score;
      } else if (clean.type === 'settings' && !clean.couch && existingDoc?.couch) {
        /* 导出备份时出于安全剥离了 settings.couch，导入时保留当前已配置的 CouchDB 连接元信息 */
        clean.couch = existingDoc.couch;
      }
      const oldRev = existingDoc?._rev;
      importMap.set(clean._id, { ...clean, ...(oldRev ? { _rev: oldRev } : {}) });
    }
    const importDocs = [...importMap.values()];
    if (importDocs.length) {
      const importedIds = new Set(importDocs.map(item => item._id));
      for (const id of importedIds) pouchMirroredTombstones.delete(id);
      await withLocalStoreLock(async () => {
        const currentLocal = await readLocalDocs();
        const cleaned = currentLocal.filter(d => !(d?._deleted && importedIds.has(d._id)));
        if (cleaned.length !== currentLocal.length) await writeLocalDocs(cleaned);
      });
      const results = await db.bulkDocs(importDocs);
      const failure = Array.isArray(results) && results.find(result => result?.error);
      if (failure) throw new Error(failure.message || '部分数据写入失败');
      if (pouchMode) await mirrorPouchToServer(null);
    }
    const count = importDocs.length;
    flushServerStore({ forceFull: true });
    const notes = [`已导入 ${count} 条数据`];
    if (skipped) notes.push(`跳过 ${skipped} 条无效记录`);
    if (repaired) notes.push(`修复 ${repaired} 条异常分数`);
    showToast(notes.join('，'));
    await render();
  } catch (error) { showToast(`导入失败：${error.message}`); }
}

function loadSavedCouchCreds() {
  try {
    const raw = localStorage.getItem(COUCH_LOCAL_CREDS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data) return null;
    if (data.mode === 'proxy') {
      return typeof data.name === 'string' && data.name ? data : null;
    }
    if (typeof data.url !== 'string' || typeof data.name !== 'string' || typeof data.user !== 'string' || typeof data.password !== 'string') {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveVerifiedCouchCreds(creds) {
  try {
    if (creds?.mode === 'proxy') {
      localStorage.setItem(COUCH_LOCAL_CREDS_KEY, JSON.stringify({
        mode: 'proxy',
        name: creds.name,
        autoConnect: Boolean(creds.autoConnect),
        verifiedAt: creds.verifiedAt || new Date().toISOString()
      }));
      return;
    }
    localStorage.setItem(COUCH_LOCAL_CREDS_KEY, JSON.stringify({
      url: creds.url,
      name: creds.name,
      user: creds.user,
      password: creds.password,
      autoConnect: Boolean(creds.autoConnect),
      verifiedAt: creds.verifiedAt || new Date().toISOString()
    }));
  } catch { /* 浏览器存储不可用或配额满时不阻断同步 */ }
}

async function refreshCouchProxyStatus() {
  if (typeof fetch !== 'function' || typeof window === 'undefined' || String(window.location?.protocol || '').startsWith('http') === false) {
    couchProxyState = { checked: true, enabled: false, db: 'studystyle' };
    return couchProxyState;
  }
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), 2500) : null;
  try {
    const res = await fetch('/api/couch/status', {
      cache: 'no-store',
      headers: serverStoreHeaders(),
      ...(ac ? { signal: ac.signal } : {})
    });
    if (res.status === 401) {
      serverTokenRequired = true;
      couchProxyState = { checked: true, enabled: false, db: 'studystyle' };
      return couchProxyState;
    }
    if (!res.ok) {
      couchProxyState = { checked: true, enabled: false, db: 'studystyle' };
      return couchProxyState;
    }
    const payload = await res.json();
    couchProxyState = {
      checked: true,
      enabled: Boolean(payload?.enabled),
      db: String(payload?.db || 'studystyle')
    };
  } catch {
    couchProxyState = { checked: true, enabled: false, db: 'studystyle' };
  } finally {
    if (timer) clearTimeout(timer);
  }
  return couchProxyState;
}

function clearSavedCouchCreds() {
  try { localStorage.removeItem(COUCH_LOCAL_CREDS_KEY); } catch {}
}

function setCouchStatus(text, variant = '') {
  couchStatusState = { text, variant };
  const status = $('#couchStatus');
  if (!status) return;
  status.className = variant ? `status-box ${variant}` : 'status-box';
  status.textContent = text;
}

function updateSyncIndicator(customLabel = null) {
  const isReconnecting = syncHandler != null && couchSyncPhase === 'reconnecting';
  const sync = (syncHandler != null && !isReconnecting) || serverStoreActive;
  const dot = $('#syncDot'); if (dot) dot.classList.toggle('connected', sync);
  const label = $('#syncLabel');
  if (label) {
    const couchLabel = isReconnecting
      ? 'CouchDB 重连中'
      : (serverStoreActive
        ? 'CouchDB + 服务端同步'
        : (couchSyncPhase === 'paused' ? 'CouchDB 已同步' : 'CouchDB 同步中'));
    label.textContent = customLabel || (syncHandler != null
      ? couchLabel
      : (serverTokenRequired ? '需要访问令牌' : (serverStoreActive ? '服务端已持久化' : '仅本机保存')));
  }
}

let pouchChangesWatcher = null;
const pouchMirroredTombstones = new Map();
const SAFE_POUCH_DOC_ID = /^[A-Za-z0-9:._-]{1,128}$/;

function isSyncableStudyDocId(id, doc = null) {
  if (typeof id !== 'string' || !id) return false;
  if (id.startsWith('_') || id.startsWith('studystyle:probe:')) return false;
  if (doc?.type === 'probe' || doc?.doc?.type === 'probe') return false;
  return SAFE_POUCH_DOC_ID.test(id);
}

/* PouchDB 原生 put/bulkDocs 不会刷新 updated_at：编辑旧卡片会沿用旧时间戳，
   导致服务端「同时间戳服务端胜」把 CouchDB 模式下的编辑静默丢弃。
   这里给本机写入统一打戳并校验 _id；复制协议写入（new_edits: false）与 _local/_design 文档原样放行。 */
function instrumentPouchWrites(pouch) {
  if (!pouch || pouch.__studystyleInstrumented) return pouch;
  const rawPut = typeof pouch.put === 'function' ? pouch.put.bind(pouch) : null;
  const rawBulk = typeof pouch.bulkDocs === 'function'
    ? pouch.bulkDocs.bind(pouch)
    : (rawPut
      ? async req => {
          const list = Array.isArray(req) ? req : (req?.docs || []);
          const out = [];
          for (const item of list) out.push(await rawPut(item));
          return out;
        }
      : null);
  const stamp = (doc, now) => {
    if (!doc || typeof doc !== 'object') return doc;
    const id = String(doc._id || '');
    if (id.startsWith('_')) return doc;
    if (!SAFE_POUCH_DOC_ID.test(id)) throw new Error('非法的文档 _id');
    return { ...doc, updated_at: now };
  };
  if (rawPut) {
    pouch.put = (doc, ...rest) => {
      const opts = rest[0];
      if (opts && typeof opts === 'object' && opts.new_edits === false) return rawPut(doc, ...rest);
      try { return rawPut(stamp(doc, new Date().toISOString()), ...rest); }
      catch (err) { return Promise.reject(err); }
    };
  }
  if (rawBulk) {
    pouch.bulkDocs = (req, ...rest) => {
      const opts = rest[0];
      const replicated = (req && !Array.isArray(req) && req.new_edits === false) || (opts && typeof opts === 'object' && opts.new_edits === false);
      if (replicated) return rawBulk(req, ...rest);
      try {
        const now = new Date().toISOString();
        if (Array.isArray(req)) return rawBulk(req.map(d => stamp(d, now)), ...rest);
        if (req && Array.isArray(req.docs)) return rawBulk({ ...req, docs: req.docs.map(d => stamp(d, now)) }, ...rest);
        return rawBulk(req, ...rest);
      } catch (err) { return Promise.reject(err); }
    };
  }
  pouch.__rawPut = rawPut;
  pouch.__rawBulkDocs = rawBulk;
  pouch.__studystyleInstrumented = true;
  return pouch;
}

/* CouchDB 模式下界面读取的是 PouchDB，而服务端 /api/store 拉回的其它设备变更只写进本机兜底存储；
   不回灌 PouchDB 的话，未接 CouchDB 的设备所做修改在本机永远看不到。
   docs 应为本地仲裁后的结果（墓碑优先），写入时绕过打戳以保留原时间戳，避免多设备间来回乒乓。 */
async function applyServerDocsToPouch(docs) {
  if (!pouchMode || !db || typeof db.allDocs !== 'function' || !Array.isArray(docs) || !docs.length) return 0;
  try {
    const snap = await db.allDocs({ include_docs: true });
    const pouchById = new Map((snap?.rows || []).map(r => r?.doc).filter(d => d?._id).map(d => [d._id, d]));
    const now = new Date().toISOString();
    const writes = [];
    for (const doc of docs) {
      const id = doc?._id;
      if (!isSyncableStudyDocId(id, doc)) continue;
      const existing = pouchById.get(id);
      const { _rev, ...clean } = doc;
      if (clean._deleted) {
        if (!existing) continue;
        const updatedAt = clean.updated_at || now;
        const tombstone = { _id: id, _deleted: true, updated_at: updatedAt, deleted_at: clean.deleted_at || updatedAt };
        pouchMirroredTombstones.set(id, tombstone);
        writes.push({ ...tombstone, _rev: existing._rev });
        continue;
      }
      if (!existing) {
        if (pouchMirroredTombstones.has(id)) continue;
        const probe = await db.get(id).catch(err => err);
        if (probe?._id || probe?.reason === 'deleted' || (probe?.status && probe.status !== 404)) continue;
        writes.push(clean);
        continue;
      }
      if (Domain.pickNewerDoc(existing, clean) !== clean) continue;
      if (docSyncFingerprint(existing) === docSyncFingerprint(clean)) continue;
      writes.push({ ...clean, _rev: existing._rev });
    }
    if (!writes.length) return 0;
    if (typeof db.__rawBulkDocs === 'function') {
      await db.__rawBulkDocs(writes);
    } else {
      const rawPut = typeof db.__rawPut === 'function' ? db.__rawPut : db.put.bind(db);
      for (const doc of writes) await rawPut(doc).catch(() => null);
    }
    return writes.length;
  } catch {
    return 0;
  }
}

function pickDocsByIds(docs, sourceDocs) {
  const ids = new Set((sourceDocs || []).map(d => d?._id).filter(Boolean));
  return (docs || []).filter(d => d?._id && ids.has(d._id));
}

function recordPouchDocChange(doc, now = new Date().toISOString()) {
  const id = doc?._id || doc?.id;
  if (!isSyncableStudyDocId(id, doc)) return null;
  if (doc?._deleted || doc?.deleted || doc?.doc?._deleted) {
    const updatedAt = doc.updated_at || doc.doc?.updated_at || doc.deleted_at || doc.doc?.deleted_at || now;
    const deletedAt = doc.deleted_at || doc.doc?.deleted_at || updatedAt;
    pouchMirroredTombstones.set(id, { _id: id, _deleted: true, updated_at: updatedAt, deleted_at: deletedAt });
  } else {
    pouchMirroredTombstones.delete(id);
  }
  return id;
}

/* 首次全量同步时 change/paused 事件密集触发：合并为单条串行循环，避免 N 次并发全量 allDocs + 落盘 */
let mirrorLoopPromise = null;
let mirrorPendingIds = new Set();
let mirrorPendingFull = false;
let mirrorPendingAny = false;

function mirrorPouchToServer(changedIds = null) {
  if (!pouchMode || !db || typeof db.allDocs !== 'function') return Promise.resolve();
  mirrorPendingAny = true;
  if (changedIds) { for (const id of changedIds) if (id) mirrorPendingIds.add(id); }
  else mirrorPendingFull = true;
  if (mirrorLoopPromise) return mirrorLoopPromise;
  mirrorLoopPromise = (async () => {
    try {
      while (mirrorPendingAny) {
        const ids = mirrorPendingFull ? null : [...mirrorPendingIds];
        mirrorPendingAny = false;
        mirrorPendingFull = false;
        mirrorPendingIds = new Set();
        await mirrorPouchOnce(ids);
      }
    } finally {
      mirrorLoopPromise = null;
    }
  })();
  return mirrorLoopPromise;
}

async function mirrorPouchOnce(changedIds = null) {
  try {
    const res = await db.allDocs({ include_docs: true });
    const liveDocs = (res?.rows || [])
      .map(r => r.doc)
      .filter(doc => doc && isSyncableStudyDocId(doc._id, doc))
      .map(doc => {
        pouchMirroredTombstones.delete(doc._id);
        return doc.updated_at ? doc : { ...doc, updated_at: new Date().toISOString() };
      });
    const combined = [...liveDocs, ...pouchMirroredTombstones.values()];
    const reconciled = await withLocalStoreLock(async () => {
      const existingLocal = await readLocalDocs();
      const res = Domain.reconcileDocSets(existingLocal, combined);
      await writeLocalDocs(res.docs);
      return res;
    });
    /* 只推送与服务端基线确有差异的文档：服务端回灌进 PouchDB 的变更不会再被原样回推（防回声） */
    const byId = new Map(reconciled.docs.filter(d => d?._id).map(d => [d._id, d]));
    const isDirty = id => {
      const d = byId.get(id);
      return Boolean(d) && isSyncableStudyDocId(d._id, d) && docSyncFingerprint(d) !== serverBaselineMap.get(id);
    };
    const dirty = changedIds
      ? [...new Set(changedIds)].filter(id => isSyncableStudyDocId(id) && isDirty(id))
      : reconciled.docs.filter(d => d?._id && isDirty(d._id)).map(d => d._id);
    if (dirty.length) pushServerStore(reconciled.docs, dirty);
  } catch {}
}

let syncRenderTimer = null;
function isEditingInsideViewRoot() {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  const root = $('#viewRoot');
  if (!active || !root || typeof root.contains !== 'function' || !root.contains(active)) return false;
  const tag = String(active.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
function scheduleSyncRender() {
  if (syncRenderTimer) clearTimeout(syncRenderTimer);
  syncRenderTimer = setTimeout(() => {
    syncRenderTimer = null;
    if (isEditingInsideViewRoot()) {
      scheduleSyncRender();
      return;
    }
    void render();
  }, 250);
}

function attachPouchServerBridge(pouch) {
  if (pouchChangesWatcher?.cancel) pouchChangesWatcher.cancel();
  if (typeof pouch?.changes !== 'function') return;
  pouchChangesWatcher = pouch.changes({ since: 'now', live: true, include_docs: true })
    .on('change', change => {
      const id = recordPouchDocChange(change);
      if (id) void mirrorPouchToServer([id]);
    });
}

function validateCouchConfig(raw) {
  if (raw?.mode === 'proxy') {
    const name = String(raw?.name || couchProxyState.db || 'studystyle').trim();
    if (!name) throw new Error('请填写数据库名');
    const origin = (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null')
      ? window.location.origin
      : 'http://localhost';
    return { mode: 'proxy', url: `${origin}/api/couch/db`, name, user: '', password: '' };
  }
  const url = String(raw?.url || '').trim().replace(/\/$/, '');
  const name = String(raw?.name || '').trim();
  const user = String(raw?.user || '').trim();
  const password = String(raw?.password ?? '');
  if (!url.startsWith('https://')) throw new Error('服务地址必须使用 HTTPS');
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new Error('请勿把账号或密码写进服务地址');
  if (!name || !user || !password) throw new Error('请填写数据库名、用户名和密码');
  return { mode: 'direct', url, name, user, password };
}

function couchInput() {
  return validateCouchConfig({
    url: $('#couchUrl')?.value,
    name: $('#couchDb')?.value,
    user: $('#couchUser')?.value,
    password: $('#couchPass')?.value
  });
}

async function migrateLocalDocsToPouch() {
  if (pouchMode) return;
  const pouch = new window.PouchDB('studystyle');
  const fallbackDocs = await readLocalDocs();
  const now = new Date().toISOString();
  const snap = await pouch.allDocs({ include_docs: true }).catch(() => ({ rows: [] }));
  const liveById = new Map((snap?.rows || []).map(r => r?.doc).filter(d => d?._id && !d._deleted).map(d => [d._id, d]));
  const writes = [];
  const missingDocs = [];

  for (const { _rev, ...doc } of fallbackDocs) {
    if (!isSyncableStudyDocId(doc?._id, doc)) continue;
    const existing = liveById.get(doc._id) || null;
    if (doc._deleted) {
      const updatedAt = doc.updated_at || now;
      const tombstone = { _id: doc._id, _deleted: true, updated_at: updatedAt, deleted_at: doc.deleted_at || updatedAt };
      pouchMirroredTombstones.set(doc._id, tombstone);
      if (existing) writes.push({ ...tombstone, _rev: existing._rev });
      continue;
    }
    if (existing) {
      if (Domain.pickNewerDoc(doc, existing) === doc && docSyncFingerprint(doc) !== docSyncFingerprint(existing)) {
        writes.push({ ...doc, _rev: existing._rev });
      }
      continue;
    }
    missingDocs.push(doc);
  }

  if (missingDocs.length) {
    let resolvedByKeys = false;
    if (typeof pouch.allDocs === 'function') {
      const keySnap = await pouch.allDocs({ keys: missingDocs.map(d => d._id) }).catch(() => null);
      const rows = keySnap?.rows;
      if (Array.isArray(rows) && rows.length === missingDocs.length && rows.every((r, idx) => r && (r.key === missingDocs[idx]._id || r.id === missingDocs[idx]._id))) {
        resolvedByKeys = true;
        for (let i = 0; i < missingDocs.length; i++) {
          const row = rows[i];
          const doc = missingDocs[i];
          if (row.value?.deleted) {
            pouchMirroredTombstones.set(doc._id, { _id: doc._id, _deleted: true, updated_at: now, deleted_at: now });
          } else if (row.error === 'not_found') {
            writes.push(doc);
          }
        }
      }
    }
    if (!resolvedByKeys) {
      for (const doc of missingDocs) {
        const probe = await pouch.get(doc._id).catch(err => err);
        if (probe?.reason === 'deleted') {
          pouchMirroredTombstones.set(doc._id, { _id: doc._id, _deleted: true, updated_at: now, deleted_at: now });
          continue;
        }
        if (probe?._id) {
          if (Domain.pickNewerDoc(doc, probe) === doc && docSyncFingerprint(doc) !== docSyncFingerprint(probe)) {
            writes.push({ ...doc, _rev: probe._rev });
          }
        } else if (!probe?.status || probe.status === 404) {
          writes.push(doc);
        }
      }
    }
  }

  if (writes.length) {
    if (typeof pouch.bulkDocs === 'function') {
      await pouch.bulkDocs(writes).catch(() => null);
    } else {
      for (const w of writes) await pouch.put(w).catch(() => null);
    }
  }
  db = instrumentPouchWrites(pouch);
  pouchMode = true;
  attachPouchServerBridge(pouch);
  await mirrorPouchToServer();
}

async function connectCouch(testOnly = false, overrideCreds = null, useServerProxy = false) {
  if (couchConnectPromise) return couchConnectPromise;
  couchConnectPromise = (async () => {
    const isSilent = Boolean(overrideCreds);
    const isProxy = Boolean(useServerProxy || overrideCreds?.mode === 'proxy');
    try {
      if (isProxy && !couchProxyState.checked && typeof refreshCouchProxyStatus === 'function') {
        await refreshCouchProxyStatus();
      }
      const info = overrideCreds
        ? validateCouchConfig(isProxy && couchProxyState.enabled && couchProxyState.db ? { ...overrideCreds, name: couchProxyState.db } : overrideCreds)
        : (isProxy
          ? validateCouchConfig({ mode: 'proxy', name: (couchProxyState.db || $('#couchDb')?.value || 'studystyle') })
          : couchInput());
      const remember = (overrideCreds || isProxy) ? true : Boolean($('#couchRememberCheck') ? $('#couchRememberCheck').checked : true);
      const existingSaved = loadSavedCouchCreds();

      await ensurePouchDB();
      await migrateLocalDocsToPouch();
      const remoteUrl = `${info.url}/${encodeURIComponent(info.name)}`;
      const remoteOpts = isProxy
        ? {
            skip_setup: true,
            fetch: (reqUrl, reqOpts = {}) => fetch(reqUrl, {
              ...reqOpts,
              headers: mergeFetchHeaders(reqOpts.headers, serverStoreHeaders())
            })
          }
        : {
            auth: { username: info.user, password: info.password },
            skip_setup: true
          };
      const remote = new window.PouchDB(remoteUrl, remoteOpts);
      setCouchStatus(isSilent ? '正在使用本机已保存的连接恢复同步…' : (isProxy ? '正在通过服务端安全代理验证数据库连接…' : '正在验证数据库连接与读写权限…'));
      await remote.info();
      const probe = `studystyle:probe:${uuid()}`;
      const inserted = await remote.put({ _id: probe, type: 'probe', at: new Date().toISOString() });
      await remote.remove({ _id: probe, _rev: inserted.rev });

      const settings = await getSetting();
      await saveSetting({
        ...(settings || {}),
        couch: isProxy ? { mode: 'proxy', name: info.name } : { url: info.url, name: info.name, user: info.user }
      });

      if (remember) {
        saveVerifiedCouchCreds({
          ...info,
          autoConnect: testOnly ? Boolean(existingSaved?.autoConnect) : true
        });
      } else {
        clearSavedCouchCreds();
      }

      if (testOnly) {
        setCouchStatus(
          isProxy
            ? '服务端安全代理测试成功，读写正常，且浏览器未保存任何 CouchDB 密码。'
            : (remember
              ? '连接成功，数据库读写权限正常。已在本机浏览器保存通过验证的同步信息（尚未开始同步）。'
              : '连接成功，数据库读写权限正常。尚未开始同步。'),
          'success'
        );
        if (!isSilent && view === 'settings') await render();
        return;
      }

      if (syncHandler) { const old = syncHandler; syncHandler = null; old.cancel(); }
      const handler = db.sync(remote, { live: true, retry: true });
      syncHandler = handler;
      couchSyncPhase = 'active';
      handler
        .on('change', async info => {
          const now = new Date().toISOString();
          const changedIds = [];
          for (const doc of info?.change?.docs || []) {
            const id = recordPouchDocChange(doc, now);
            if (id) changedIds.push(id);
          }
          await mirrorPouchToServer(changedIds.length ? changedIds : null);
          scheduleSyncRender();
        })
        .on('paused', err => {
          if (syncHandler !== handler) return;
          /* paused(err) 表示网络中断或远端异常，retry 会自动重连，不能误报「已同步」 */
          if (err) {
            couchSyncPhase = 'reconnecting';
            setCouchStatus(`同步暂停，等待网络恢复后自动重试：${err.message || err}`, 'error');
            updateSyncIndicator('CouchDB 重连中');
            return;
          }
          couchSyncPhase = 'paused';
          setCouchStatus(remember ? '已同步，正在监听远端变更（已保存本机免重填凭据）。' : '已同步，正在监听变更。', 'success');
          updateSyncIndicator(serverStoreActive ? 'CouchDB + 服务端同步' : 'CouchDB 已同步');
          void mirrorPouchToServer();
        })
        .on('active', () => {
          if (syncHandler !== handler) return;
          couchSyncPhase = 'active';
          setCouchStatus('同步中…');
          updateSyncIndicator('CouchDB 同步中');
        })
        .on('denied', error => { setCouchStatus(`权限不足：${error?.message || error}`, 'error'); })
        .on('error', error => {
          /* 致命错误后复制已停止：释放句柄，网络恢复（online）时 resumeSavedCouchSync 才能重连 */
          if (syncHandler === handler) { syncHandler = null; couchSyncPhase = 'idle'; }
          setCouchStatus(`同步错误：${error?.message || error}`, 'error');
          updateSyncIndicator();
        })
        .on('complete', () => {
          if (syncHandler === handler) { syncHandler = null; couchSyncPhase = 'idle'; updateSyncIndicator(); }
        });

      setCouchStatus(
        remember
          ? '连接成功，双向同步已启动并长期保存于本机浏览器。'
          : '连接成功，首次双向同步已启动。首次同步期间请保持此页面打开。',
        'success'
      );
      await render();
    } catch (error) {
      let msg = error?.message || '连接失败，请检查地址、认证、CORS 和数据库权限。';
      if (isProxy && (error?.status === 401 || /401|unauthorized/i.test(String(msg)))) {
        msg = '鉴权未通过（401）：请核对「同源访问令牌 STORE_TOKEN」及服务端 CouchDB 代理凭据（COUCH_PROXY_USER/PASSWORD）。';
      }
      setCouchStatus(isSilent ? `自动恢复同步失败：${msg}` : msg, 'error');
    } finally {
      couchConnectPromise = null;
    }
  })();
  return couchConnectPromise;
}

async function resumeSavedCouchSync() {
  if (syncHandler || couchConnectPromise) return;
  const saved = loadSavedCouchCreds();
  if (!saved?.autoConnect || (!saved.password && saved.mode !== 'proxy')) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    /* 离线冷启动：仍切换至本地 IndexedDB PouchDB 读取已同步数据，联网后再启动远端复制 */
    if (!pouchMode) {
      try {
        await ensurePouchDB();
        await migrateLocalDocsToPouch();
        setCouchStatus('当前处于离线模式，已使用本地数据库；联网后将自动恢复同步。');
        await render();
      } catch {}
    }
    return;
  }
  await connectCouch(false, saved, saved.mode === 'proxy');
}

async function disconnectCouch() {
  if (syncHandler) { syncHandler.cancel(); syncHandler = null; }
  couchSyncPhase = 'idle';
  const saved = loadSavedCouchCreds();
  if (saved) saveVerifiedCouchCreds({ ...saved, autoConnect: false });
  setCouchStatus(saved
    ? '已断开远端同步（本机已保存的连接信息仍保留，可随时重新连接或清除）。'
    : '已断开远端同步。');
  await render();
  showToast('已断开远端同步，本地数据保留');
}

async function forgetSavedCouch() {
  if (syncHandler) { syncHandler.cancel(); syncHandler = null; }
  couchSyncPhase = 'idle';
  clearSavedCouchCreds();
  const settings = await getSetting();
  if (settings?.couch) {
    const { couch, ...rest } = settings;
    await saveSetting(rest);
  }
  setCouchStatus('已清除本浏览器保存的同步服务器信息与密码。');
  await render();
  showToast('已清除本机保存的同步凭据');
}

async function balanceOverdueNow() {
  const due = await dueCards();
  const settings = (await getSetting()) || {};
  const rawCap = settings.daily_review_limit;
  const cap = rawCap === undefined || rawCap === null ? 15 : Number(rawCap);
  if (!Number.isFinite(cap) || cap <= 0) {
    showToast('当前每日上限设为「不设上限」，如需平滑分流请先设定具体上限');
    return;
  }
  if (due.length <= cap) {
    showToast(`当前待复习 ${due.length} 张，未超过单日上限（${cap} 张），无需分流`);
    return;
  }
  const plan = Domain.balanceOverdueCards(due, localDay(), cap);
  if (!plan.length) return;
  const dueById = new Map(due.map(card => [card._id, card]));
  const updates = [];
  for (const item of plan) {
    const doc = dueById.get(item.id) || (await db.get(item.id).catch(() => null));
    if (doc) updates.push({ ...doc, due_date: item.due_date });
  }
  if (updates.length) await db.bulkDocs(updates);
  showToast(`已将超额的 ${plan.length} 张卡片平滑分流至未来数日`);
  await render();
}

async function seedDemoCards() {
  const today = localDay();
  const demos = [
    {
      title: '光合作用的两个阶段与核心场所',
      outline: '### 1. 光反应阶段\n- 场所：叶绿体 **类囊体薄膜**\n- 物质变化：水的光解产生 ==O2== 与 NADPH；合成 ==ATP==\n### 2. 暗反应阶段（卡尔文循环）\n- 场所：**叶绿体基质**\n- 过程：CO2 的固定 → ==C3的还原==（消耗 ATP 和 NADPH）',
      notebook: '生物',
      tags: ['生物', '示例卡片'],
      due_date: today,
      interval_index: 1,
      latest_memory_score: 35
    },
    {
      title: 'TCP 三次握手与四次挥手核心要点',
      outline: '### 三次握手（建立连接）\n- 第一次：客户端发送 **SYN=1**, seq=x\n- 第二次：服务端回复 ==SYN=1, ACK=1==, ack=x+1\n- 第三次：客户端发送 **ACK=1**, 进入 ==ESTABLISHED== 状态\n### 为什么需要三次而非两次？\n- 防止已失效的连接请求报文段突然又传送到了服务端，产生错误连接',
      notebook: '计算机网络',
      tags: ['计算机网络', '示例卡片'],
      due_date: today,
      interval_index: 0,
      latest_memory_score: null
    },
    {
      title: '间隔复习与主动回忆',
      outline: '- 核心理念：**先回忆（Active Recall）**，再看答案核对\n- 6 级记忆梯度：待首次复习 / 待加强 / 较弱 / 一般 / 较好 / 熟悉\n- 低于 ==60%==（可在设置中调整）时默认不推进并收缩稳定度，避免盲目拉长间隔',
      notebook: '学习方法',
      tags: ['学习方法', '示例卡片'],
      due_date: addDays(today, 2),
      interval_index: 2,
      latest_memory_score: 75
    }
  ];
  const settings = (await getSetting()) || {};
  const savedNbs = Array.isArray(settings.notebooks) ? [...settings.notebooks] : [];
  const nowIso = new Date().toISOString();
  const docsToPut = demos.map(item => {
    if (!savedNbs.some(n => (typeof n === 'string' ? n : n?.name) === item.notebook)) {
      savedNbs.push({ name: item.notebook, color: Domain.NOTEBOOK_COLORS[savedNbs.length % Domain.NOTEBOOK_COLORS.length] });
    }
    return {
      _id: `card:${uuid()}`,
      type: 'card',
      title: item.title,
      outline: item.outline,
      notebook: item.notebook,
      tags: item.tags,
      created_at: nowIso,
      archived_at: null,
      interval_index: item.interval_index,
      due_date: item.due_date,
      last_reviewed_at: null,
      latest_memory_score: item.latest_memory_score
    };
  });
  await db.bulkDocs(docsToPut);
  await saveSetting({ ...settings, notebooks: savedNbs });
  showToast('已载入 3 个科目笔记本与示例卡片，可立即体验科目切换与复习');
  await render();
}

