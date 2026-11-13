import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Domain from './domain.cjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));

const publicFiles = new Set([
  'index.html',
  'styles.css',
  'app.js',
  'domain.cjs',
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

// CSP 需兼容现有页面：index.html 内联 style、app.js 内联 style 属性与 innerHTML 注入、
// PouchDB 由 cdn.jsdelivr.net 懒加载，因此放行 unsafe-inline 与该 CDN 域名。
// connect-src 允许任意 https 是因为 CouchDB 远端地址由用户在设置页填写（app.js 要求 https）；
// worker-src 放行 blob: 是因为 PouchDB 的 mapreduce 插件通过 blob URL 创建 Worker。
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
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

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...extraHeaders
  });
  res.end(body);
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

function validateStorePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  if (!Array.isArray(body.docs)) {
    throw new HttpError(400, 'docs 必须是数组');
  }
  body.docs.forEach((doc, index) => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new HttpError(400, `docs[${index}] 必须是对象`);
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
  return { docs: body.docs, baseRev };
}

function createStore(dataDir) {
  const storeFile = join(dataDir, 'studystyle-db.json');
  const storeName = 'studystyle-db.json';
  const corruptPrefix = `${storeName}.corrupt.`;
  let writeChain = Promise.resolve();

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

  async function read() {
    let raw;
    try {
      raw = await readFile(storeFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // 文件缺失可能是「从未存过数据」，也可能是损坏后被隔离；后者绝不能冒充无数据
        const backup = await findCorruptBackup();
        if (backup) throw new HttpError(500, `存储文件缺失（曾损坏并备份为 ${basename(backup)}），请恢复后重试`);
        return { rev: 'r0', docs: [] };
      }
      throw new HttpError(500, `读取存储文件失败: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const backup = await backupCorrupt();
      throw new HttpError(500, `存储文件已损坏，已备份为 ${basename(backup || '未知文件')}，请修复后重试`);
    }
    const docs = Array.isArray(parsed) ? parsed : parsed?.docs;
    if (!Array.isArray(docs)) {
      const backup = await backupCorrupt();
      throw new HttpError(500, `存储文件结构非法，已备份为 ${basename(backup || '未知文件')}，请修复后重试`);
    }
    const rev = typeof parsed?.rev === 'string' && parsed.rev ? parsed.rev : 'r0';
    return { rev, docs };
  }

  // 读-合并-写整体在写链内串行，保证并发写不会丢数据
  async function commit(clientDocs, baseRev) {
    const task = writeChain.catch(() => {}).then(async () => {
      const current = await read();
      const rev = nextRev(current.rev);
      const mismatch = typeof baseRev === 'string' && baseRev !== current.rev;
      const docs = mismatch ? mergeDocs(current.docs, clientDocs) : clientDocs;
      await mkdir(dataDir, { recursive: true });
      const payload = JSON.stringify({
        app: 'StudyStyle',
        updated_at: new Date().toISOString(),
        rev,
        docs
      }, null, 2);
      const tmpFile = `${storeFile}.tmp`;
      await writeFile(tmpFile, payload, 'utf8');
      await rename(tmpFile, storeFile);
      return { rev, merged: mismatch, count: docs.length, docs };
    });
    writeChain = task;
    return task;
  }

  return { read, commit, storeFile, flush: () => writeChain.catch(() => {}) };
}

function readJsonBody(req, maxBytes) {
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
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveBody(text ? JSON.parse(text) : {});
      } catch {
        rejectBody(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', err => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    });
  });
}

export function createStudyStyleServer(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || join(root, 'data'));
  const storeToken = String(options.storeToken ?? process.env.STORE_TOKEN ?? '').trim();
  const maxBodyBytes = Number(options.maxBodyBytes || process.env.MAX_BODY_BYTES || 10 * 1024 * 1024);
  const logger = options.logger || console;
  const store = createStore(dataDir);

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

  function assertToken(req) {
    if (!storeToken) return;
    const provided = String(req.headers['x-store-token'] || '');
    if (provided !== storeToken) throw new HttpError(401, '缺少或错误的 X-Store-Token');
  }

  function assertJsonContentType(req) {
    const raw = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (raw !== 'application/json' && !raw.endsWith('+json')) {
      throw new HttpError(415, '仅接受 application/json');
    }
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
        sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
        return;
      }

      if (pathname === '/api/store') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          assertSameOrigin(req);
          assertToken(req);
          const { rev, docs } = await store.read();
          sendJson(res, 200, { ok: true, rev, docs });
          return;
        }
        if (req.method === 'PUT') {
          assertSameOrigin(req);
          assertToken(req);
          assertJsonContentType(req);
          const declared = Number(req.headers['content-length'] || 0);
          if (declared > maxBodyBytes) throw new HttpError(413, 'Payload Too Large');
          const body = await readJsonBody(req, maxBodyBytes);
          const { docs, baseRev } = validateStorePayload(body);
          const result = await store.commit(docs, baseRev);
          /* 合并时回传完整 docs，客户端据此回填本地，避免两端分叉 */
          sendJson(res, 200, { ok: true, rev: result.rev, merged: result.merged, count: result.count, docs: result.docs });
          return;
        }
        throw new HttpError(405, 'Method Not Allowed', { Allow: 'GET, PUT' });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      }
      const requestedFile = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (requestedFile.includes('/') || !publicFiles.has(requestedFile)) throw new HttpError(404, 'Not Found');
      const candidate = resolve(root, requestedFile);
      let info;
      try {
        info = await stat(candidate);
      } catch {
        throw new HttpError(404, 'Not Found');
      }
      if (!info.isFile()) throw new HttpError(404, 'Not Found');
      const body = await readFile(candidate);
      res.writeHead(200, {
        'Content-Type': mime[extname(candidate)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
        ...SECURITY_HEADERS
      });
      res.end(body);
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
        sendJson(res, 413, { ok: false, error: message }, { ...headers, Connection: 'close' });
        res.on('finish', () => req.destroy());
        return;
      }
      // 错误响应前未消费请求体时排空，避免连接悬挂
      if (!req.complete) req.resume();
      sendJson(res, status, { ok: false, error: message }, headers);
    }
  }

  const server = createServer(handle);
  server.flushStore = store.flush;

  // 自行处理 100-continue：超限请求直接 413，不再先回 100 Continue
  server.on('checkContinue', (req, res) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBodyBytes) {
      sendJson(res, 413, { ok: false, error: 'Payload Too Large' });
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
