import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import Domain from './domain.cjs';

const gzip = promisify(gzipCallback);

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));

const publicFiles = new Set([
  'index.html',
  'styles.css',
  'styles/tokens.css',
  'styles/layout.css',
  'styles/components.css',
  'styles/views.css',
  'styles/glass-responsive.css',
  'domain.cjs',
  'src/state.js',
  'src/store.js',
  'src/views.js',
  'src/review.js',
  'app.js',
  'vendor/pouchdb.min.js',
  'manifest.webmanifest',
  'sw.js',
  'favicon.svg',
  'icon.svg',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png'
]);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

// CSP 说明：所有 JS 均外链自同源 'self'（包含本地托管的 vendor/pouchdb.min.js），彻底移除 'unsafe-inline' 与第三方 CDN 脚本依赖；
// style-src 因动态图谱/色标等内联样式属性暂保留 'unsafe-inline'；
// connect-src 放行 https: 以支持用户自填远端 CouchDB 地址；worker-src 放行 blob: 以兼容 PouchDB mapreduce worker。
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
});

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const GZIP_THRESHOLD_BYTES = 512;

function isCompressibleType(contentType) {
  return contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('javascript') || contentType.includes('svg');
}

async function sendPayload(req, res, status, contentType, bodyInput, extraHeaders = {}) {
  const buf = Buffer.isBuffer(bodyInput) ? bodyInput : Buffer.from(String(bodyInput), 'utf8');
  const compressible = isCompressibleType(contentType);
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
    ...SECURITY_HEADERS,
    ...extraHeaders
  };
  if (req?.method === 'HEAD') {
    headers['Content-Length'] = buf.length;
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const acceptsGzip = compressible && buf.length >= GZIP_THRESHOLD_BYTES && /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] || ''));
  if (acceptsGzip) {
    const compressed = await gzip(buf);
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = compressed.length;
    res.writeHead(status, headers);
    res.end(compressed);
    return;
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJson(res, status, payload, extraHeaders = {}, req = null) {
  return sendPayload(req, res, status, 'application/json; charset=utf-8', JSON.stringify(payload), extraHeaders);
}

function nextRev(current) {
  const matched = /^r(\d+)$/.exec(String(current || ''));
  return matched ? `r${Number(matched[1]) + 1}` : 'r1';
}

// 同一张卡两版本都存在时按 updated_at 取新。
// 缺失时间戳的语义：客户端无戳+服务端有戳 → 服务端胜（老数据不得盖掉服务端新数据）；
// 客户端有戳+服务端无戳 → 客户端胜（客户端刚编辑过，服务端那份是旧存档）；
// 双方都无戳 → 客户端胜（客户端是本次操作的发起方）。
function mergeDocs(serverDocs, clientDocs) {
  const serverById = new Map(serverDocs.filter(doc => doc?._id).map(doc => [doc._id, doc]));
  const merged = [];
  const taken = new Set();
  for (const clientDoc of clientDocs) {
    const id = clientDoc._id;
    taken.add(id);
    const serverDoc = serverById.get(id);
    merged.push(Domain.pickNewerDoc(clientDoc, serverDoc));
  }
  for (const serverDoc of serverDocs) {
    // 无 _id 的历史文档无法参与合并，直接保留以免丢数据
    if (!serverDoc?._id || !taken.has(serverDoc._id)) merged.push(serverDoc);
  }
  return merged;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasUnsafeKeys(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return false;
  if (Array.isArray(value)) return value.some(item => hasUnsafeKeys(item, depth + 1));
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key) || hasUnsafeKeys(value[key], depth + 1)) return true;
  }
  return false;
}

function validateStorePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  if (Object.keys(body).some(k => DANGEROUS_KEYS.has(k))) {
    throw new HttpError(400, '请求体包含非法原型键');
  }
  const mode = body.mode === undefined ? 'full' : body.mode;
  if (mode !== 'full' && mode !== 'delta') {
    throw new HttpError(400, 'mode 必须是 full 或 delta');
  }
  if (!Array.isArray(body.docs)) {
    throw new HttpError(400, 'docs 必须是数组');
  }
  body.docs.forEach((doc, index) => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new HttpError(400, `docs[${index}] 必须是对象`);
    }
    if (hasUnsafeKeys(doc)) {
      throw new HttpError(400, `docs[${index}] 包含非法原型键`);
    }
    if (typeof doc._id !== 'string' || !doc._id) {
      throw new HttpError(400, `docs[${index}] 缺少有效 _id`);
    }
    /* _id 会进入 HTML 属性（data-review-card 等），限定字符集从入口杜绝属性注入 */
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(doc._id)) {
      throw new HttpError(400, `docs[${index}]._id 含非法字符`);
    }
  });
  const baseRev = body.base_rev === undefined || body.base_rev === null ? undefined : body.base_rev;
  if (baseRev !== undefined && typeof baseRev !== 'string') {
    throw new HttpError(400, 'base_rev 必须是字符串');
  }
  if (mode === 'delta' && !baseRev) {
    throw new HttpError(400, 'delta 模式必须提供 base_rev');
  }
  return { docs: body.docs, baseRev, mode };
}

function compactDocForStore(doc) {
  if (!doc || typeof doc !== 'object' || !doc._deleted) return doc;
  const compact = { _id: doc._id, _deleted: true };
  if (doc._rev !== undefined) compact._rev = doc._rev;
  if (doc.updated_at !== undefined) compact.updated_at = doc.updated_at;
  if (doc.deleted_at !== undefined) compact.deleted_at = doc.deleted_at;
  return compact;
}

function createStore(dataDir) {
  const storeFile = join(dataDir, 'studystyle-db.json');
  const deltaFile = join(dataDir, 'studystyle-delta.json');
  const storeName = 'studystyle-db.json';
  const corruptPrefix = `${storeName}.corrupt.`;
  let writeChain = Promise.resolve();
  let cachedSnap = null;
  let writeSeq = 0;
  /* 最近增量变更环（最多保留 200 个版本），持久化到 sidecar studystyle-delta.json，
     使服务端重启后 ?since=<rev> 仍可命中增量同步；超出窗口或手工换库时自动回退完整快照。 */
  const MAX_DELTA_LOG = 200;
  const deltaLog = [];
  let deltaLoadPromise = null;

  async function ensureDeltaLoaded() {
    if (!deltaLoadPromise) {
      deltaLoadPromise = (async () => {
        try {
          const raw = await readFile(deltaFile, 'utf8');
          const parsed = JSON.parse(raw);
          const entries = Array.isArray(parsed?.entries) ? parsed.entries : (Array.isArray(parsed) ? parsed : []);
          deltaLog.length = 0;
          for (const item of entries.slice(-MAX_DELTA_LOG)) {
            if (typeof item?.fromRev !== 'string' || typeof item?.toRev !== 'string' || !Array.isArray(item?.changedIds)) continue;
            deltaLog.push({
              fromRev: item.fromRev,
              toRev: item.toRev,
              changedIds: new Set(item.changedIds.map(String))
            });
          }
        } catch {
          deltaLog.length = 0;
        }
      })();
    }
    return deltaLoadPromise;
  }

  async function persistDeltaLog() {
    try {
      const payload = JSON.stringify({
        version: 1,
        entries: deltaLog.map(entry => ({
          fromRev: entry.fromRev,
          toRev: entry.toRev,
          changedIds: [...entry.changedIds]
        }))
      });
      const tmpDelta = `${deltaFile}.${process.pid}.${++writeSeq}.tmp`;
      await writeFile(tmpDelta, payload, 'utf8');
      await rename(tmpDelta, deltaFile);
    } catch (err) {
      console.warn?.(`[studystyle] 写入增量日志失败（不影响主库）: ${err.message}`);
    }
  }

  function recordDelta(fromRev, toRev, prevDocs, nextDocs) {
    if (deltaLog.length && deltaLog[deltaLog.length - 1].toRev !== fromRev) {
      deltaLog.length = 0;
    }
    const prevById = new Map(prevDocs.filter(d => d?._id).map(d => [d._id, JSON.stringify(d)]));
    const nextById = new Map(nextDocs.filter(d => d?._id).map(d => [d._id, JSON.stringify(d)]));
    const changedIds = new Set();
    for (const [id, serialized] of nextById) {
      if (prevById.get(id) !== serialized) changedIds.add(id);
    }
    for (const id of prevById.keys()) {
      if (!nextById.has(id)) changedIds.add(id);
    }
    deltaLog.push({ fromRev, toRev, changedIds });
    if (deltaLog.length > MAX_DELTA_LOG) deltaLog.shift();
  }

  function changesSinceRev(sinceRev, currentRev, docs) {
    if (!sinceRev) return { known: false, unchanged: false, changes: null };
    if (sinceRev === currentRev) return { known: true, unchanged: true, changes: [] };
    if (!deltaLog.length || deltaLog[deltaLog.length - 1].toRev !== currentRev) {
      return { known: false, unchanged: false, changes: null };
    }
    const startIdx = deltaLog.findIndex(entry => entry.fromRev === sinceRev);
    if (startIdx < 0) return { known: false, unchanged: false, changes: null };
    const changedIds = new Set();
    for (let i = startIdx; i < deltaLog.length; i++) {
      for (const id of deltaLog[i].changedIds) changedIds.add(id);
    }
    const byId = new Map(docs.filter(d => d?._id).map(d => [d._id, d]));
    const changes = [];
    for (const id of changedIds) {
      const doc = byId.get(id);
      if (!doc) return { known: false, unchanged: false, changes: null };
      changes.push(doc);
    }
    return { known: true, unchanged: false, changes };
  }

  // 损坏文件先备份再报错：直接覆盖会让唯一一份数据永久消失
  async function backupCorrupt() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = join(dataDir, `${corruptPrefix}${stamp}`);
    try {
      await rename(storeFile, backupFile);
      return backupFile;
    } catch (err) {
      console.error(`[studystyle] 备份损坏的存储文件失败: ${err.message}`);
      return null;
    }
  }

  // 备份存在说明数据文件此前损坏并被隔离，缺失不等于「无数据」
  async function findCorruptBackup() {
    try {
      const names = (await readdir(dataDir)).filter(name => name.startsWith(corruptPrefix)).sort();
      return names.length ? join(dataDir, names[names.length - 1]) : null;
    } catch {
      return null;
    }
  }

  async function read(sinceRev = undefined) {
    await ensureDeltaLoaded();
    let infoBefore;
    try {
      infoBefore = await stat(storeFile, { bigint: true });
      if (cachedSnap && cachedSnap.mtimeNs === infoBefore.mtimeNs && cachedSnap.size === infoBefore.size) {
        if (typeof sinceRev === 'string' && sinceRev) {
          const delta = changesSinceRev(sinceRev, cachedSnap.rev, cachedSnap.docs);
          if (delta.known) {
            return { rev: cachedSnap.rev, incremental: true, unchanged: delta.unchanged, changes: delta.changes };
          }
        }
        return { rev: cachedSnap.rev, docs: cachedSnap.docs, incremental: false };
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        cachedSnap = null;
        // 文件缺失可能是「从未存过数据」，也可能是损坏后被隔离；后者绝不能冒充无数据
        const backup = await findCorruptBackup();
        if (backup) throw new HttpError(500, `存储文件缺失（曾损坏并备份为 ${basename(backup)}），请恢复后重试`);
        if (sinceRev === 'r0') return { rev: 'r0', docs: [], incremental: true, unchanged: true, changes: [] };
        return { rev: 'r0', docs: [], incremental: false };
      }
      throw new HttpError(500, `读取存储文件失败: ${err.message}`);
    }
    let raw;
    try {
      raw = await readFile(storeFile, 'utf8');
    } catch (err) {
      cachedSnap = null;
      if (err.code === 'ENOENT') {
        const backup = await findCorruptBackup();
        if (backup) throw new HttpError(500, `存储文件缺失（曾损坏并备份为 ${basename(backup)}），请恢复后重试`);
        if (sinceRev === 'r0') return { rev: 'r0', docs: [], incremental: true, unchanged: true, changes: [] };
        return { rev: 'r0', docs: [], incremental: false };
      }
      throw new HttpError(500, `读取存储文件失败: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      cachedSnap = null;
      const backup = await backupCorrupt();
      throw new HttpError(500, `存储文件已损坏，已备份为 ${basename(backup || '未知文件')}，请修复后重试`);
    }
    const docs = Array.isArray(parsed) ? parsed : parsed?.docs;
    if (!Array.isArray(docs)) {
      cachedSnap = null;
      const backup = await backupCorrupt();
      throw new HttpError(500, `存储文件结构非法，已备份为 ${basename(backup || '未知文件')}，请修复后重试`);
    }
    const rev = typeof parsed?.rev === 'string' && parsed.rev ? parsed.rev : 'r0';
    try {
      const infoAfter = await stat(storeFile, { bigint: true });
      cachedSnap = { rev, docs, mtimeNs: infoAfter.mtimeNs, size: infoAfter.size };
    } catch {
      cachedSnap = null;
    }
    if (typeof sinceRev === 'string' && sinceRev) {
      const delta = changesSinceRev(sinceRev, rev, docs);
      if (delta.known) {
        return { rev, incremental: true, unchanged: delta.unchanged, changes: delta.changes };
      }
    }
    return { rev, docs, incremental: false };
  }

  // 读-合并-写整体在写链内串行，保证并发写不会丢数据
  async function commit(clientDocs, baseRev, mode = 'full') {
    const task = writeChain.catch(() => {}).then(async () => {
      const current = await read();
      const rev = nextRev(current.rev);
      const mismatch = typeof baseRev === 'string' && baseRev !== current.rev;
      const isDelta = mode === 'delta';
      const normalizedIncoming = clientDocs.map(compactDocForStore);
      const merged = (isDelta || mismatch) ? mergeDocs(current.docs, normalizedIncoming) : normalizedIncoming;
      const docs = merged.map(compactDocForStore);
      await mkdir(dataDir, { recursive: true });
      const payload = JSON.stringify({
        app: 'StudyStyle',
        updated_at: new Date().toISOString(),
        rev,
        docs
      }, null, 2);
      const tmpFile = `${storeFile}.${process.pid}.${++writeSeq}.tmp`;
      await writeFile(tmpFile, payload, 'utf8');
      await rename(tmpFile, storeFile);
      try {
        const st = await stat(storeFile, { bigint: true });
        cachedSnap = { rev, docs, mtimeNs: st.mtimeNs, size: st.size };
      } catch {
        cachedSnap = null;
      }
      recordDelta(current.rev, rev, current.docs, docs);
      await persistDeltaLog();
      if (isDelta) {
        if (!mismatch) {
          return { rev, merged: false, mode: 'delta', count: docs.length, changes: [] };
        }
        const deltaSince = changesSinceRev(baseRev, rev, docs);
        return deltaSince.known
          ? { rev, merged: true, mode: 'delta', count: docs.length, changes: deltaSince.changes }
          : { rev, merged: true, mode: 'delta', count: docs.length, docs };
      }
      return { rev, merged: mismatch, mode: 'full', count: docs.length, docs };
    });
    writeChain = task;
    return task;
  }

  return { read, commit, storeFile, deltaFile, flush: () => writeChain.catch(() => {}) };
}

function readRawBody(req, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        rejectBody(new HttpError(413, 'Payload Too Large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      resolveBody(Buffer.concat(chunks));
    });
    req.on('error', err => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    });
  });
}

async function readJsonBody(req, maxBytes) {
  const buf = await readRawBody(req, maxBytes);
  try {
    const text = buf.toString('utf8');
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function buildCouchProxyConfig(options = {}) {
  const rawUrl = String(options.couchProxyUrl ?? process.env.COUCH_PROXY_URL ?? '').trim();
  const explicitDb = String(options.couchProxyDb ?? process.env.COUCH_PROXY_DB ?? '').trim();
  let rawDb = explicitDb || 'studystyle';
  if (!rawUrl) return { enabled: false, db: rawDb };
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { enabled: false, db: rawDb };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { enabled: false, db: rawDb };
  }
  const user = String(options.couchProxyUser ?? process.env.COUCH_PROXY_USER ?? (parsed.username ? decodeURIComponent(parsed.username) : '')).trim();
  const password = String(options.couchProxyPassword ?? process.env.COUCH_PROXY_PASSWORD ?? (parsed.password ? decodeURIComponent(parsed.password) : ''));
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  /* 容错：用户常把数据库名写进 COUCH_PROXY_URL（如 http://couchdb:5984/studystyle）；
     若未显式指定 COUCH_PROXY_DB 则自动提取库名，并剥离末尾重复的 /<db> 防止拼出 /studystyle/studystyle 404 */
  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  if (pathSegments.length > 0) {
    const lastSeg = decodeURIComponent(pathSegments[pathSegments.length - 1]);
    if (!explicitDb && pathSegments.length === 1 && !lastSeg.startsWith('_')) {
      rawDb = lastSeg;
      pathSegments.pop();
      parsed.pathname = '/';
    } else if (lastSeg === rawDb) {
      pathSegments.pop();
      parsed.pathname = pathSegments.length ? `/${pathSegments.join('/')}` : '/';
    }
  }
  if (!rawDb || rawDb.startsWith('_') || rawDb === '.' || rawDb === '..' || /[\\/?#\s]/.test(rawDb)) {
    return { enabled: false, db: 'studystyle' };
  }
  const baseUrl = parsed.toString().replace(/\/+$/, '');
  const authHeader = (user || password)
    ? `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
    : '';
  return { enabled: true, baseUrl, authHeader, db: rawDb };
}

function createAuthRateLimiter(options = {}) {
  const limit = Number(options.authFailLimit ?? process.env.AUTH_FAIL_LIMIT ?? 20);
  const windowMs = Math.max(1000, Number(options.authWindowMs ?? process.env.AUTH_WINDOW_MS ?? 60_000));
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const attempts = new Map();

  function prune(list, now) {
    const cutoff = now - windowMs;
    while (list.length && list[0] <= cutoff) list.shift();
    return list;
  }

  function retryAfterSeconds(key) {
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    const now = nowFn();
    const list = attempts.get(key);
    if (!list) return 0;
    prune(list, now);
    if (!list.length) {
      attempts.delete(key);
      return 0;
    }
    if (list.length < limit) return 0;
    return Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
  }

  function recordFailure(key) {
    if (!Number.isFinite(limit) || limit <= 0) return;
    const now = nowFn();
    if (attempts.size > 4096) {
      for (const [k, v] of attempts) {
        prune(v, now);
        if (!v.length) attempts.delete(k);
      }
    }
    const list = attempts.get(key) || [];
    prune(list, now);
    list.push(now);
    attempts.set(key, list);
  }

  function clear(key) {
    attempts.delete(key);
  }

  return { retryAfterSeconds, recordFailure, clear };
}

export function createStudyStyleServer(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || join(root, 'data'));
  const storeToken = String(options.storeToken ?? process.env.STORE_TOKEN ?? '').trim();
  const maxBodyBytes = Number(options.maxBodyBytes || process.env.MAX_BODY_BYTES || 10 * 1024 * 1024);
  const trustProxy = Boolean(options.trustProxy ?? (process.env.TRUST_PROXY === '1'));
  const logger = options.logger || console;
  const store = createStore(dataDir);
  const couchProxy = buildCouchProxyConfig(options);
  const authLimiter = createAuthRateLimiter(options);

  function clientKey(req) {
    if (trustProxy) {
      /* 取由直接相连的可信反代（如 Caddy）追加到末尾的客户端 IP，避免伪造左端 X-Forwarded-For 绕过限流 */
      const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return String(req.socket?.remoteAddress || 'unknown');
  }

  // 只比对 host：服务端无 TLS 概念，浏览器也不会让脚本伪造 Host 头
  function isSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const host = String(req.headers.host || '').toLowerCase();
    if (!host) return false;
    try {
      return new URL(origin).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }

  function assertSameOrigin(req) {
    if (!isSameOrigin(req)) throw new HttpError(403, '跨源请求被拒绝');
  }

  function sha256Digest(text) {
    return createHash('sha256').update(String(text || ''), 'utf8').digest();
  }

  const storeTokenDigest = storeToken ? sha256Digest(storeToken) : null;

  function assertToken(req) {
    if (!storeTokenDigest) return;
    const ip = clientKey(req);
    const retryAfter = authLimiter.retryAfterSeconds(ip);
    if (retryAfter > 0) {
      throw new HttpError(429, `鉴权失败次数过多，请在 ${retryAfter} 秒后重试`, { 'Retry-After': String(retryAfter) });
    }
    const provided = String(req.headers['x-store-token'] || '');
    if (!timingSafeEqual(sha256Digest(provided), storeTokenDigest)) {
      authLimiter.recordFailure(ip);
      throw new HttpError(401, '缺少或错误的 X-Store-Token');
    }
    authLimiter.clear(ip);
  }

  function assertJsonContentType(req) {
    const raw = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (raw !== 'application/json' && !raw.endsWith('+json')) {
      throw new HttpError(415, '仅接受 application/json');
    }
  }

  async function forwardCouchProxy(req, res, url, subpath, decodedSubpath = subpath) {
    if (!couchProxy.enabled) throw new HttpError(503, '服务端未配置 COUCH_PROXY_URL');
    if (decodedSubpath.includes('..') || decodedSubpath.includes('\\') || subpath.includes('..') || subpath.includes('\\')) {
      throw new HttpError(400, '代理路径非法');
    }
    /* 单库沙箱隔离：仅允许访问服务端配置的 couchProxy.db，阻止借代理凭据探测 /_all_dbs、/_users、/_config 或其它数据库 */
    const cleanDecoded = decodedSubpath.startsWith('/') ? decodedSubpath.slice(1) : decodedSubpath;
    const subParts = cleanDecoded.split('/').filter(Boolean);
    const targetDbSeg = subParts[0] || '';
    if (targetDbSeg !== couchProxy.db) {
      throw new HttpError(403, '仅允许访问服务端配置的代理数据库');
    }
    /* 代理只服务文档与同步复制：严禁整库 DELETE / 覆写 PUT /{db}，以及 /_security、/_purge 等管理端点 */
    const methodUpper = String(req.method || 'GET').toUpperCase();
    if (subParts.length === 1 && !['GET', 'HEAD', 'POST'].includes(methodUpper)) {
      throw new HttpError(403, '代理禁止整库删除或库级改写操作');
    }
    const subResource = subParts[1] || '';
    if (['_security', '_purge', '_compact', '_revs_limit', '_view_cleanup'].includes(subResource)) {
      throw new HttpError(403, '代理禁止访问数据库管理端点');
    }
    const cleanSub = subpath ? (subpath.startsWith('/') ? subpath : `/${subpath}`) : '/';
    const targetUrl = `${couchProxy.baseUrl}${cleanSub}${url.search}`;
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBodyBytes) throw new HttpError(413, 'Payload Too Large');
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method || 'GET');
    const rawBody = hasBody ? await readRawBody(req, maxBodyBytes) : undefined;
    const forwardHeaders = {};
    for (const key of ['content-type', 'accept', 'if-match', 'if-none-match']) {
      if (req.headers[key]) forwardHeaders[key] = String(req.headers[key]);
    }
    if (couchProxy.authHeader) forwardHeaders.authorization = couchProxy.authHeader;

    const feedType = url.searchParams.get('feed') || '';
    const isLongPoll = cleanSub.endsWith('/_changes') || feedType === 'longpoll' || feedType === 'continuous';
    const baseTimeoutMs = Number(options.couchProxyTimeoutMs || process.env.COUCH_PROXY_TIMEOUT_MS || 30000);
    const reqTimeoutMs = isLongPoll
      ? Math.max(baseTimeoutMs, Math.min(120000, (Number(url.searchParams.get('timeout')) || 60000) + 15000))
      : baseTimeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), reqTimeoutMs);
    const onClientClose = () => controller.abort();
    req.once('aborted', onClientClose);
    res.once('close', onClientClose);

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: rawBody && rawBody.length > 0 ? rawBody : undefined,
        signal: controller.signal
      });
    } catch {
      clearTimeout(timer);
      req.off('aborted', onClientClose);
      res.off('close', onClientClose);
      throw new HttpError(502, '上游 CouchDB 服务连接失败或超时');
    }

    const outHeaders = {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS
    };
    const etag = upstream.headers.get('etag');
    if (etag) outHeaders.ETag = etag;
    const contentLength = upstream.headers.get('content-length');
    if (contentLength && !upstream.headers.get('content-encoding')) {
      outHeaders['Content-Length'] = contentLength;
    }

    if (req.method === 'HEAD' || !upstream.body) {
      clearTimeout(timer);
      req.off('aborted', onClientClose);
      res.off('close', onClientClose);
      outHeaders['Content-Length'] = '0';
      res.writeHead(upstream.status, outHeaders);
      res.end();
      return;
    }

    res.writeHead(upstream.status, outHeaders);
    const nodeStream = Readable.fromWeb(upstream.body);
    const cleanupProxyListeners = () => {
      clearTimeout(timer);
      req.off('aborted', onClientClose);
      res.off('close', onClientClose);
      res.off('close', cleanupProxyListeners);
    };
    res.once('close', cleanupProxyListeners);
    nodeStream.once('close', cleanupProxyListeners);
    nodeStream.on('error', () => {
      cleanupProxyListeners();
      if (!res.writableEnded) res.destroy();
    });
    nodeStream.on('end', cleanupProxyListeners);
    nodeStream.pipe(res);
  }

  async function handle(req, res) {
    let pathname = '/';
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.log?.(`[studystyle] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new HttpError(400, '请求路径编码非法');
      }

      if (pathname === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          throw new HttpError(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
        }
        await sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() }, {}, req);
        return;
      }

      if (pathname === '/api/store') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          assertSameOrigin(req);
          assertToken(req);
          const sinceRev = url.searchParams.get('since') || undefined;
          const result = await store.read(sinceRev);
          if (result.incremental) {
            await sendJson(res, 200, { ok: true, rev: result.rev, incremental: true, unchanged: result.unchanged, changes: result.changes }, {}, req);
          } else {
            await sendJson(res, 200, { ok: true, rev: result.rev, incremental: false, docs: result.docs }, {}, req);
          }
          return;
        }
        if (req.method === 'PUT') {
          assertSameOrigin(req);
          assertToken(req);
          assertJsonContentType(req);
          const declared = Number(req.headers['content-length'] || 0);
          if (declared > maxBodyBytes) throw new HttpError(413, 'Payload Too Large');
          const body = await readJsonBody(req, maxBodyBytes);
          const { docs, baseRev, mode } = validateStorePayload(body);
          const result = await store.commit(docs, baseRev, mode);
          /* full 模式回传完整 docs（兼容契约）；delta 模式无冲突仅回传 rev/count，冲突时仅回传变化量或兜底 docs */
          await sendJson(res, 200, {
            ok: true,
            rev: result.rev,
            merged: result.merged,
            mode: result.mode,
            count: result.count,
            ...(result.changes !== undefined ? { changes: result.changes } : {}),
            ...(result.docs !== undefined ? { docs: result.docs } : {})
          }, {}, req);
          return;
        }
        throw new HttpError(405, 'Method Not Allowed', { Allow: 'GET, HEAD, PUT' });
      }

      if (pathname === '/api/couch/status') {
        assertSameOrigin(req);
        assertToken(req);
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          throw new HttpError(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
        }
        await sendJson(res, 200, { ok: true, enabled: couchProxy.enabled, db: couchProxy.db }, {}, req);
        return;
      }

      if (pathname === '/api/couch/db' || pathname.startsWith('/api/couch/db/')) {
        assertSameOrigin(req);
        assertToken(req);
        const decodedSubpath = pathname.slice('/api/couch/db'.length);
        const rawSubpath = url.pathname.startsWith('/api/couch/db')
          ? url.pathname.slice('/api/couch/db'.length)
          : decodedSubpath;
        await forwardCouchProxy(req, res, url, rawSubpath, decodedSubpath);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      }
      const requestedFile = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (requestedFile.includes('..') || !publicFiles.has(requestedFile)) throw new HttpError(404, 'Not Found');
      const candidate = resolve(root, requestedFile);
      let info;
      try {
        info = await stat(candidate);
      } catch {
        throw new HttpError(404, 'Not Found');
      }
      if (!info.isFile()) throw new HttpError(404, 'Not Found');
      const contentType = mime[extname(candidate)] || 'application/octet-stream';
      const etag = `W/"${info.size}-${Math.trunc(info.mtimeMs)}"`;
      const ifNoneMatch = String(req.headers['if-none-match'] || '');
      const matchedEtag = ifNoneMatch && ifNoneMatch.split(',').some(tag => tag.trim() === etag || tag.trim() === '*');
      if (matchedEtag) {
        res.writeHead(304, {
          ETag: etag,
          'Cache-Control': 'no-cache',
          ...(isCompressibleType(contentType) ? { Vary: 'Accept-Encoding' } : {}),
          ...SECURITY_HEADERS
        });
        res.end();
        return;
      }
      const body = await readFile(candidate);
      await sendPayload(req, res, 200, contentType, body, {
        ETag: etag,
        'Cache-Control': 'no-cache'
      });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : '服务器内部错误';
      if (status >= 500 || (status >= 400 && status !== 404)) {
        logger.error?.(`[studystyle] ${req.method} ${pathname} -> ${status}: ${message}`);
        if (status >= 500 && err.stack) logger.error?.(err.stack);
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      const headers = err instanceof HttpError ? err.headers : {};
      if (status === 413) {
        // 请求体超限：回完 413 立刻断开，避免继续接收攻击者上传的海量数据
        await sendJson(res, 413, { ok: false, error: message }, { ...headers, Connection: 'close' }, req);
        res.on('finish', () => req.destroy());
        return;
      }
      // 错误响应前未消费请求体时排空，避免连接悬挂
      if (!req.complete) req.resume();
      await sendJson(res, status, { ok: false, error: message }, headers, req);
    }
  }

  const server = createServer(handle);
  server.flushStore = store.flush;

  // 自行处理 100-continue：超限请求直接 413，不再先回 100 Continue
  server.on('checkContinue', (req, res) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBodyBytes) {
      void sendJson(res, 413, { ok: false, error: 'Payload Too Large' }, { Connection: 'close' }, req)
        .finally(() => { if (!req.destroyed) req.destroy(); });
      return;
    }
    res.writeContinue();
    handle(req, res);
  });

  return server;
}

const selfPath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = Boolean(entryPath) && (process.platform === 'win32'
  ? entryPath.toLowerCase() === selfPath.toLowerCase()
  : entryPath === selfPath);

if (isMain) {
  const port = Number(process.env.PORT || 3880);
  const host = process.env.HOST || '0.0.0.0';
  const server = createStudyStyleServer();
  let shuttingDown = false;
  server.listen(port, host, () => {
    const actual = server.address();
    console.log(`StudyStyle is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${actual.port} (data: ${resolve(process.env.DATA_DIR || join(root, 'data'))})`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const timeout = setTimeout(() => {
        server.closeAllConnections?.();
        process.exit(1);
      }, 5000);
      timeout.unref?.();
      server.close(() => {
        server.flushStore().finally(() => {
          clearTimeout(timeout);
          process.exit(0);
        });
      });
      server.closeIdleConnections?.();
    });
  }
}
