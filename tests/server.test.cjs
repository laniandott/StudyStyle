const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const storeName = 'studystyle-db.json';

let createStudyStyleServer;
let tmpRoots = [];

test.before(async () => {
  // server.mjs 为 ESM，从 CJS 用动态 import 引入（Windows 必须用 file:// URL）
  ({ createStudyStyleServer } = await import(pathToFileURL(path.join(root, 'server.mjs')).href));
});

test.after(async () => {
  for (const dir of tmpRoots) await fsp.rm(dir, { recursive: true, force: true });
});

async function makeDataDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studystyle-test-'));
  tmpRoots.push(dir);
  return dir;
}

// 在临时目录上启动真实 HTTP 服务，避免污染项目 data/
async function startServer(options = {}) {
  const dataDir = options.dataDir || (await makeDataDir());
  const server = createStudyStyleServer({ logger: { log() {}, error() {} }, dataDir, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    dataDir,
    port,
    base: `http://127.0.0.1:${port}`,
    storeFile: path.join(dataDir, storeName),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

// 起真实子进程，验证环境变量（STORE_TOKEN / DATA_DIR）这条部署路径
async function startServerProcess(env = {}) {
  const dataDir = env.DATA_DIR || (await makeDataDir());
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, ...env }
  });
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('服务端启动超时')), 10000);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const matched = buffer.match(/running at http:\/\/[^:]+:(\d+)/);
      if (matched) {
        clearTimeout(timer);
        resolve(Number(matched[1]));
      }
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return {
    dataDir,
    port,
    base: `http://127.0.0.1:${port}`,
    storeFile: path.join(dataDir, storeName),
    stop: () => new Promise(resolve => {
      child.on('exit', resolve);
      child.kill('SIGTERM');
    })
  };
}

function putJson(base, body, headers = {}) {
  return fetch(`${base}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function card(id, extra = {}) {
  return { _id: id, title: `卡片 ${id}`, updated_at: '2026-01-01T00:00:00.000Z', ...extra };
}

// 1 & 2：非法入参必须 400，且绝不清空既有数据
test('非法入参返回 400 且不改动服务端数据', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a')] });
  const before = await (await fetch(`${srv.base}/api/store`)).json();

  const notArray = await putJson(srv.base, { docs: '不是数组' });
  assert.equal(notArray.status, 400);
  assert.equal((await notArray.json()).ok, false);

  const missing = await putJson(srv.base, {});
  assert.equal(missing.status, 400);

  const badElement = await putJson(srv.base, { docs: [{ title: '缺 _id' }] });
  assert.equal(badElement.status, 400);

  const primitiveElement = await putJson(srv.base, { docs: ['字符串元素'] });
  assert.equal(primitiveElement.status, 400);

  const after = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(after.docs.length, 1);
  assert.equal(after.docs[0]._id, 'a');
  assert.deepEqual(after.docs, before.docs);
});

// 3：存储文件损坏时备份原文件并返回 500，绝不冒充「无数据」
test('存储文件损坏时返回 500 并保留 .corrupt 备份', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const corrupted = '{"docs":[{"_id":"a"';
  await fsp.writeFile(srv.storeFile, corrupted, 'utf8');

  const res = await fetch(`${srv.base}/api/store`);
  assert.equal(res.status, 500);
  const payload = await res.json();
  assert.equal(payload.ok, false);
  assert.match(payload.error, /损坏/);

  const files = await fsp.readdir(srv.dataDir);
  const backups = files.filter(name => name.startsWith(`${storeName}.corrupt.`));
  assert.equal(backups.length, 1);
  // 损坏内容必须原样保留在备份里，不能被空数据覆盖
  assert.equal(await fsp.readFile(path.join(srv.dataDir, backups[0]), 'utf8'), corrupted);

  // 后续读取仍然报 500，不得退化成空数组
  const again = await fetch(`${srv.base}/api/store`);
  assert.equal(again.status, 500);
});

// 4：跨源写请求必须 403
test('跨源 Origin 的写请求被拒绝为 403', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a')] });

  const res = await putJson(srv.base, { docs: [] }, {
    Origin: 'https://evil.example.com',
    'Content-Type': 'text/plain'
  });
  assert.equal(res.status, 403);

  const after = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(after.docs.length, 1);
});

// 5：配置 STORE_TOKEN 后必须带正确令牌
test('STORE_TOKEN 生效时缺少令牌返回 401、携带正确令牌返回 200', async t => {
  const srv = await startServerProcess({ STORE_TOKEN: 'secret-token' });
  t.after(() => srv.stop());

  const missing = await putJson(srv.base, { docs: [card('a')] });
  assert.equal(missing.status, 401);

  const wrong = await putJson(srv.base, { docs: [card('a')] }, { 'X-Store-Token': 'wrong' });
  assert.equal(wrong.status, 401);

  const ok = await putJson(srv.base, { docs: [card('a')] }, { 'X-Store-Token': 'secret-token' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).count, 1);

  const read = await fetch(`${srv.base}/api/store`);
  assert.equal(read.status, 401);
});

// 6：base_rev 不匹配时执行三方合并，双方卡片都要保留
test('base_rev 不匹配时执行合并而非整库覆盖', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a'), card('b')] });
  const serverRev = (await (await fetch(`${srv.base}/api/store`)).json()).rev;

  // 客户端基于旧 rev 推入 1 张新卡
  const res = await putJson(srv.base, { docs: [card('c')], base_rev: 'r0' });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.merged, true);
  assert.equal(payload.count, 3);

  const merged = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(merged.docs.length, 3);
  assert.deepEqual(merged.docs.map(d => d._id).sort(), ['a', 'b', 'c']);
  assert.notEqual(merged.rev, serverRev);
});

// 7：base_rev 匹配时走单设备直接替换
test('base_rev 匹配时直接替换整库', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a'), card('b')] });
  const { rev } = await (await fetch(`${srv.base}/api/store`)).json();

  const res = await putJson(srv.base, { docs: [card('z')], base_rev: rev });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.merged, false);
  assert.equal(payload.count, 1);

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.deepEqual(current.docs.map(d => d._id), ['z']);
});

// 7b：不带 base_rev 的写入视为「整库替换」（向后兼容老客户端）
// 注意：本项目自己的客户端已改为「无 rev 时先 GET 再推」，不会走到这条路径；
// 这条断言只为记录服务端对外部老客户端的兼容行为，不代表推荐用法。
test('不带 base_rev 的写入保持整库替换（兼容外部老客户端）', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a'), card('b')] });
  const res = await putJson(srv.base, { docs: [card('c')] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).merged, false);

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.deepEqual(current.docs.map(d => d._id), ['c']);
});

// 7b-1：删除通过墓碑传播，服务端旧副本不会被「复活」
test('删除以墓碑形式传播，服务端不会复活已删除的卡片', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [{ ...card('a'), updated_at: '2026-01-01T00:00:00.000Z' }] });
  // 故意用陈旧 rev 触发合并路径（模拟另一台设备持有的旧快照）
  const res = await putJson(srv.base, {
    base_rev: 'r0',
    docs: [{ _id: 'a', _deleted: true, updated_at: '2026-06-01T00:00:00.000Z' }]
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).merged, true);

  // 服务端保留墓碑而不再保留活文档，避免下次合并把卡片复活
  const current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs.length, 1);
  assert.equal(current.docs[0]._id, 'a');
  assert.equal(current.docs[0]._deleted, true);
});

// 7b-2：任何写入都必须推进 rev，否则乐观锁失效（两台设备会互相整库覆盖）
test('每次写入都推进 rev，确保乐观锁在直接替换路径同样生效', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const revs = [];
  for (let i = 0; i < 3; i++) {
    const res = await putJson(srv.base, { docs: [card(`c${i}`)] });
    revs.push((await res.json()).rev);
  }
  assert.equal(new Set(revs).size, 3, `rev 未推进: ${revs.join(',')}`);

  // 设备B 持有最早的 rev，后续任何写入都会让它失配 → 走合并而非覆盖
  const staleRev = revs[0];
  const merged = await putJson(srv.base, { docs: [card('from-b')], base_rev: staleRev });
  assert.equal((await merged.json()).merged, true);
});

// 7c：同一张卡两边都有时按 updated_at 取新，相同则保留服务端版本
test('合并同一张卡时 updated_at 较新的一方胜出，相同时保留服务端版本', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a', { title: '服务端', updated_at: '2026-01-01T00:00:00.000Z' })] });
  const { rev } = await (await fetch(`${srv.base}/api/store`)).json();

  // 客户端版本更新 → 客户端胜出
  await putJson(srv.base, {
    docs: [card('a', { title: '客户端较新', updated_at: '2026-06-01T00:00:00.000Z' })],
    base_rev: 'r0'
  });
  let current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs.length, 1);
  assert.equal(current.docs[0].title, '客户端较新');

  // 客户端版本更旧 → 服务端版本保留
  await putJson(srv.base, {
    docs: [card('a', { title: '客户端较旧', updated_at: '2025-01-01T00:00:00.000Z' })],
    base_rev: 'r0'
  });
  current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs[0].title, '客户端较新');

  // updated_at 完全相同 → 保留服务端版本（服务端权威）
  const serverVersion = current.docs[0];
  await putJson(srv.base, {
    docs: [card('a', { title: '客户端同时间不同内容', updated_at: serverVersion.updated_at })],
    base_rev: 'r0'
  });
  current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs[0].title, serverVersion.title);
});

// 8：非法 JSON 请求体返回 400
test('请求体不是合法 JSON 时返回 400', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const res = await putJson(srv.base, '{"docs": [');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

// 9：超大请求体返回 413
test('超出体积上限的请求体返回 413', async t => {
  const srv = await startServer({ maxBodyBytes: 1024 });
  t.after(() => srv.close());

  const res = await putJson(srv.base, { docs: [card('a', { blob: 'x'.repeat(4096) })] });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).ok, false);
});

// 10：GET 返回体必须带 rev 字段
test('GET /api/store 返回 rev 与 docs', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a')] });
  const payload = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.rev, 'string');
  assert.ok(payload.rev.length > 0);
  assert.equal(payload.docs.length, 1);
});

// 11：响应必须带齐 5 个安全响应头
test('响应包含 5 个安全响应头', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const api = await fetch(`${srv.base}/api/store`);
  const page = await fetch(`${srv.base}/index.html`);
  for (const res of [api, page]) {
    assert.ok(res.headers.get('content-security-policy'), '缺少 CSP');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(res.headers.get('permissions-policy'), '缺少 Permissions-Policy');
  }
  assert.match(api.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(api.headers.get('content-security-policy').includes('jsdelivr'), false, 'script-src 不得依赖外部 CDN');
});

test('正常请求日志包含路径和状态码，不包含学习文档内容', async t => {
  const entries = [];
  const srv = await startServer({ logger: { log: line => entries.push(line), error: line => entries.push(String(line)) } });
  t.after(() => srv.close());
  const privateTitle = 'private study note 7f3a';

  const response = await putJson(srv.base, { docs: [card('a', { title: privateTitle })] });
  assert.equal(response.status, 200);
  assert.ok(entries.some(line => line.includes('PUT /api/store 200')));
  assert.ok(entries.every(line => !line.includes(privateTitle)));
});

// 附加：错误码分级
test('错误码分级：405 带 Allow 头、415 拒绝非 JSON、404 静态资源缺失', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const notAllowed = await fetch(`${srv.base}/api/store`, { method: 'POST' });
  assert.equal(notAllowed.status, 405);
  assert.match(notAllowed.headers.get('allow'), /PUT/);

  const badType = await fetch(`${srv.base}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ docs: [] })
  });
  assert.equal(badType.status, 415);

  const missing = await fetch(`${srv.base}/not-exist.html`);
  assert.equal(missing.status, 404);

  const ok = await fetch(`${srv.base}/api/store`);
  assert.equal(ok.status, 200);
});

// 附加：读操作也做 Origin 校验，防止跨站读取学习数据
test('跨源 GET 请求被拒绝为 403', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const res = await fetch(`${srv.base}/api/store`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(res.status, 403);
});

// 附加：并发写必须串行落盘，不出现文件损坏或丢写
test('并发写请求全部成功且存储文件保持合法 JSON', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, i) => putJson(srv.base, { docs: [card(`c${i}`)] }))
  );
  for (const res of responses) assert.equal(res.status, 200);

  const raw = await fsp.readFile(srv.storeFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.docs));
  assert.equal(parsed.docs.length, 1);
  assert.equal(typeof parsed.rev, 'string');
});

// 附加：健康检查与静态资源仍然可用
test('健康检查与静态资源不受加固影响', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const health = await fetch(`${srv.base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const index = await fetch(`${srv.base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);

  const assets = await Promise.all(['styles.css', 'app.js', 'domain.cjs', 'favicon.svg', 'manifest.webmanifest', 'sw.js', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'].map(
    name => fetch(`${srv.base}/${name}`)
  ));
  for (const res of assets) assert.equal(res.status, 200);
});

// 附加：PWA 清单、Service Worker 与 PNG 图标响应头与内容合法
test('PWA 清单、Service Worker 与图标接口可用', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const manifestRes = await fetch(`${srv.base}/manifest.webmanifest`);
  assert.equal(manifestRes.status, 200);
  assert.match(manifestRes.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = await manifestRes.json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(i => i.sizes === '192x192' && i.type === 'image/png'));
  assert.ok(manifest.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable'));

  const swRes = await fetch(`${srv.base}/sw.js`);
  assert.equal(swRes.status, 200);
  assert.match(swRes.headers.get('content-type'), /javascript/);
  const swText = await swRes.text();
  assert.match(swText, /\/api\//);

  for (const iconName of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    const iconRes = await fetch(`${srv.base}/${iconName}`);
    assert.equal(iconRes.status, 200);
    assert.equal(iconRes.headers.get('content-type'), 'image/png');
    const bytes = new Uint8Array(await iconRes.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${iconName} 应为合法 PNG`);
  }
});

// 附加：删除墓碑必须能传播，否则服务端残留的旧卡片会被「复活」
test('删除墓碑（_deleted）在合并时胜出，旧卡片不被复活', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('card:1', { updated_at: '2026-01-01T00:00:00.000Z' })] });
  const { rev } = await (await fetch(`${srv.base}/api/store`)).json();

  // 客户端B 删除 card:1，写入墓碑（updated_at 更新）
  await putJson(srv.base, {
    docs: [card('card:1', { _deleted: true, updated_at: '2026-06-01T00:00:00.000Z' })],
    base_rev: rev
  });

  // 客户端A 手上有旧副本（未删除），用失配的 base_rev 推上来 —— 墓碑必须胜出
  await putJson(srv.base, {
    docs: [card('card:1', { title: '客户端A的旧副本', updated_at: '2026-01-01T00:00:00.000Z' })],
    base_rev: 'r0'
  });

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  const doc = current.docs.find(d => d._id === 'card:1');
  assert.ok(doc, 'card:1 不应凭空消失');
  assert.equal(doc._deleted, true, '墓碑应保留，旧卡片不得复活');
});

// 附加：墓碑必须原样透传给客户端，否则删除意图无法传播到其它设备
test('GET 透传墓碑，客户端据此得知其它设备的删除', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a'), card('b')] });
  await putJson(srv.base, {
    docs: [card('a'), card('b', { _deleted: true, updated_at: '2026-06-01T00:00:00.000Z' })],
    base_rev: 'r0'
  });

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  const tombstone = current.docs.find(d => d._id === 'b');
  assert.ok(tombstone, '服务端必须保留 b 的墓碑');
  assert.equal(tombstone._deleted, true, '墓碑必须原样返回给客户端，否则删除无法跨设备传播');
});

// 附加：缺 updated_at 时不得让客户端编辑被旧数据覆盖（架构审计 P0-3）
test('客户端文档缺少 updated_at 时以客户端版本为准', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  // 服务端存着无时间戳的「老数据」
  await putJson(srv.base, { docs: [{ _id: 'card:1', title: '老数据原样' }] });

  // 客户端编辑后推送（带时间戳），rev 失配走合并 —— 客户端编辑必须保留
  await putJson(srv.base, {
    docs: [card('card:1', { title: '客户端编辑后的新内容', updated_at: '2026-06-01T00:00:00.000Z' })],
    base_rev: 'r0'
  });

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs[0].title, '客户端编辑后的新内容', '客户端编辑被老数据覆盖了');
});

// 附加：客户端无戳、服务端有戳时服务端胜出（老数据不得盖掉服务端新数据）
test('客户端文档缺少 updated_at 而服务端有戳时保留服务端版本', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('a', { updated_at: '2026-06-01T00:00:00.000Z' })] });
  await putJson(srv.base, {
    docs: [{ _id: 'a', title: '客户端的无戳旧数据' }],
    base_rev: 'r0'
  });

  const current = await (await fetch(`${srv.base}/api/store`)).json();
  assert.equal(current.docs[0].title, '卡片 a', '服务端新数据被客户端无戳旧数据覆盖了');
});

// 附加：_id 会进入 HTML 属性，必须限定字符集
test('_id 含非法字符时返回 400 且不写入', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('card:1')] });
  const before = (await (await fetch(`${srv.base}/api/store`)).json()).docs.length;

  for (const badId of ['card onload=alert(1)', 'a"b', 'a<b', 'x'.repeat(129)]) {
    const res = await putJson(srv.base, { docs: [card(badId)] });
    assert.equal(res.status, 400, `应拒绝 _id=${badId.slice(0, 20)}`);
    assert.equal((await res.json()).ok, false);
  }

  const after = (await (await fetch(`${srv.base}/api/store`)).json()).docs.length;
  assert.equal(after, before, '非法 _id 不得写入任何数据');
});

// 附加：项目 data/ 目录未被测试污染
test('测试全部使用临时目录，项目 data/ 不被写入', () => {
  const dataDir = path.join(root, 'data');
  if (!fs.existsSync(dataDir)) return;
  const entries = fs.readdirSync(dataDir);
  assert.deepEqual(entries.filter(name => name.includes('.corrupt.')), []);
});


test('增量同步：GET ?since=<rev> 无变更返回 unchanged，有变更仅返回变更文档', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await putJson(srv.base, { docs: [card('c1'), card('c2')] });
  const init = await (await fetch(`${srv.base}/api/store`)).json();

  const sameRes = await (await fetch(`${srv.base}/api/store?since=${encodeURIComponent(init.rev)}`)).json();
  assert.equal(sameRes.incremental, true);
  assert.equal(sameRes.unchanged, true);
  assert.deepEqual(sameRes.changes, []);
  assert.equal(sameRes.docs, undefined);

  await putJson(srv.base, {
    mode: 'delta',
    base_rev: init.rev,
    docs: [card('c2', { title: '已更新 c2', updated_at: '2026-06-01T00:00:00.000Z' })]
  });

  const deltaRes = await (await fetch(`${srv.base}/api/store?since=${encodeURIComponent(init.rev)}`)).json();
  assert.equal(deltaRes.incremental, true);
  assert.equal(deltaRes.unchanged, false);
  assert.deepEqual(deltaRes.changes.map(d => d._id), ['c2']);
  assert.equal(deltaRes.changes[0].title, '已更新 c2');

  const full = await (await fetch(`${srv.base}/api/store`)).json();
  assert.deepEqual(full.docs.map(d => d._id).sort(), ['c1', 'c2'], 'delta 更新不能抹掉未包含的 c1');
});

test('增量同步：PUT mode=delta 校验 base_rev 且冲突时仅回传变化集', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const badDelta = await putJson(srv.base, { mode: 'delta', docs: [card('c1')] });
  assert.equal(badDelta.status, 400);

  await putJson(srv.base, { docs: [card('c1'), card('c2')] });
  const { rev } = await (await fetch(`${srv.base}/api/store`)).json();

  await putJson(srv.base, { mode: 'delta', base_rev: rev, docs: [card('remote-only')] });

  const conflictRes = await putJson(srv.base, { mode: 'delta', base_rev: rev, docs: [card('local-only')] });
  assert.equal(conflictRes.status, 200);
  const conflictBody = await conflictRes.json();
  assert.equal(conflictBody.merged, true);
  assert.equal(conflictBody.mode, 'delta');
  assert.ok(Array.isArray(conflictBody.changes));
  const changeIds = conflictBody.changes.map(d => d._id).sort();
  assert.deepEqual(changeIds, ['local-only', 'remote-only'], '冲突增量仅含两次变化涉及的文档');
  assert.equal(conflictBody.docs, undefined);
});


test('模块化静态资源目录（src/ 与 styles/）白名单可访问且禁止越权路径', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const paths = [
    'styles/tokens.css',
    'styles/layout.css',
    'styles/components.css',
    'styles/views.css',
    'styles/glass-responsive.css',
    'src/state.js',
    'src/store.js',
    'src/views.js',
    'src/review.js',
    'app.js'
  ];
  for (const rel of paths) {
    const res = await fetch(`${srv.base}/${rel}`);
    assert.equal(res.status, 200, `${rel} 应返回 200`);
  }
  assert.equal((await fetch(`${srv.base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${srv.base}/src/not-exist.js`)).status, 404);
});

test('服务端 CouchDB 安全代理：支持 STORE_TOKEN 校验、注入上游凭据且不泄露密码', async t => {
  const { createServer: createHttpServer } = require('node:http');
  const seen = [];
  const mockCouch = createHttpServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body });
      res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': '"1-mock"' });
      res.end(JSON.stringify({ db_name: 'studystyle', ok: true, id: 'probe1', rev: '1-mock' }));
    });
  });
  await new Promise(r => mockCouch.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => mockCouch.close(r)));
  const couchPort = mockCouch.address().port;

  const srv = await startServer({
    storeToken: 'proxy-secret-token',
    couchProxyUrl: `http://127.0.0.1:${couchPort}`,
    couchProxyUser: 'couch-user',
    couchProxyPassword: 'couch-password-xyz',
    couchProxyDb: 'my_notes'
  });
  t.after(() => srv.close());

  // 未带 STORE_TOKEN 被拒 401
  assert.equal((await fetch(`${srv.base}/api/couch/status`)).status, 401);
  assert.equal((await fetch(`${srv.base}/api/couch/db/my_notes`)).status, 401);

  // status 返回 enabled 与 db，但绝对不含密码
  const statusRes = await fetch(`${srv.base}/api/couch/status`, {
    headers: { 'X-Store-Token': 'proxy-secret-token' }
  });
  assert.equal(statusRes.status, 200);
  const statusText = await statusRes.text();
  const statusJson = JSON.parse(statusText);
  assert.deepEqual({ ok: statusJson.ok, enabled: statusJson.enabled, db: statusJson.db }, { ok: true, enabled: true, db: 'my_notes' });
  assert.equal(statusText.includes('couch-password-xyz'), false);

  // 代理请求注入 Basic Auth 并透传路径与 query
  const proxyPut = await fetch(`${srv.base}/api/couch/db/my_notes/probe1?batch=ok`, {
    method: 'PUT',
    headers: {
      'X-Store-Token': 'proxy-secret-token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ _id: 'probe1', type: 'probe' })
  });
  assert.equal(proxyPut.status, 200);
  const expectedAuth = `Basic ${Buffer.from('couch-user:couch-password-xyz').toString('base64')}`;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'PUT');
  assert.equal(seen[0].url, '/my_notes/probe1?batch=ok');
  assert.equal(seen[0].auth, expectedAuth);

  // 路径穿越被拦截
  const badPath = await fetch(`${srv.base}/api/couch/db/my_notes/..%2Fsecret`, {
    headers: { 'X-Store-Token': 'proxy-secret-token' }
  });
  assert.equal(badPath.status, 400);

  // %2F 编码文档 ID 透传不被破坏
  const encodedDoc = await fetch(`${srv.base}/api/couch/db/my_notes/folder%2Fdoc1`, {
    headers: { 'X-Store-Token': 'proxy-secret-token' }
  });
  assert.equal(encodedDoc.status, 200);
  assert.equal(seen[1].url, '/my_notes/folder%2Fdoc1');

  // 单库沙箱隔离：禁止越权访问 /_all_dbs、/_users、非配置数据库，以及整库删除/覆写与管理端点
  for (const forbidden of [
    '/api/couch/db/_all_dbs',
    '/api/couch/db/_users/org.couchdb.user:admin',
    '/api/couch/db/other_db/doc1',
    '/api/couch/db/my_notes/_security',
    '/api/couch/db/my_notes/_purge'
  ]) {
    const res = await fetch(`${srv.base}${forbidden}`, {
      headers: { 'X-Store-Token': 'proxy-secret-token' }
    });
    assert.equal(res.status, 403, `越权路径 ${forbidden} 必须返回 403`);
  }
  for (const dangerousMethod of ['DELETE', 'PUT']) {
    const res = await fetch(`${srv.base}/api/couch/db/my_notes`, {
      method: dangerousMethod,
      headers: { 'X-Store-Token': 'proxy-secret-token' }
    });
    assert.equal(res.status, 403, `代理不得允许整库 ${dangerousMethod} /my_notes`);
  }

  // COUCH_PROXY_URL 末尾已带数据库名时自动去重，不拼出 /my_notes/my_notes
  const srvWithDbInUrl = await startServer({
    storeToken: 'proxy-secret-token',
    couchProxyUrl: `http://127.0.0.1:${couchPort}/my_notes`
  });
  t.after(() => srvWithDbInUrl.close());
  const statusAutoDb = await (await fetch(`${srvWithDbInUrl.base}/api/couch/status`, {
    headers: { 'X-Store-Token': 'proxy-secret-token' }
  })).json();
  assert.equal(statusAutoDb.db, 'my_notes');
  const dedupRes = await fetch(`${srvWithDbInUrl.base}/api/couch/db/my_notes/doc-dedup`, {
    headers: { 'X-Store-Token': 'proxy-secret-token' }
  });
  assert.equal(dedupRes.status, 200);
  assert.equal(seen[seen.length - 1].url, '/my_notes/doc-dedup');
});

test('服务端 CouchDB 代理兼容 longpoll 长连接与流式透传，不因短超时掐断 _changes', async t => {
  const { createServer: createHttpServer } = require('node:http');
  const mockCouch = createHttpServer((req, res) => {
    if (req.url.includes('_changes')) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [{ id: 'c1', seq: '2-abc' }], last_seq: '2-abc' }));
      }, 180);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise(r => mockCouch.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => mockCouch.close(r)));

  const srv = await startServer({
    couchProxyUrl: `http://127.0.0.1:${mockCouch.address().port}`,
    couchProxyTimeoutMs: 60
  });
  t.after(() => srv.close());

  // 即使基础 timeout=60ms，_changes?feed=longpoll 仍应自动放宽超时窗口并完整流式返回
  const lp = await fetch(`${srv.base}/api/couch/db/studystyle/_changes?feed=longpoll&timeout=500`);
  assert.equal(lp.status, 200);
  const lpBody = await lp.json();
  assert.equal(lpBody.last_seq, '2-abc');
});

test('CSP script-src 禁止 unsafe-inline，且 STORE_TOKEN 连续鉴权失败触发 429 限流', async t => {
  const srv = await startServer({
    storeToken: 'top-secret-token',
    authFailLimit: 3,
    authWindowMs: 5000
  });
  t.after(() => srv.close());

  const page = await fetch(`${srv.base}/`);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy') || '';
  const scriptSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src ')) || '';
  assert.equal(scriptSrc, "script-src 'self'", 'script-src 仅允许同源 self 且不得包含 unsafe-inline 或外部 CDN');
  const pouchBundleRes = await fetch(`${srv.base}/vendor/pouchdb.min.js`);
  assert.equal(pouchBundleRes.status, 200);
  assert.match(String(pouchBundleRes.headers.get('content-type') || ''), /javascript/);

  // 连续 3 次错误令牌均应返回 401
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${srv.base}/api/store`, { headers: { 'X-Store-Token': 'wrong' } });
    assert.equal(res.status, 401);
  }
  // 第 4 次即使携带错误（或被暂时锁定），同一 IP 在窗口内应被限流为 429 + Retry-After
  const blocked = await fetch(`${srv.base}/api/store`, { headers: { 'X-Store-Token': 'top-secret-token' } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);

  // 未锁定时携带正确令牌应清零失败计数（新开一实例验证）
  const srv2 = await startServer({ storeToken: 'reset-ok', authFailLimit: 2, authWindowMs: 5000 });
  t.after(() => srv2.close());
  assert.equal((await fetch(`${srv2.base}/api/store`, { headers: { 'X-Store-Token': 'bad' } })).status, 401);
  assert.equal((await fetch(`${srv2.base}/api/store`, { headers: { 'X-Store-Token': 'reset-ok' } })).status, 200);
  assert.equal((await fetch(`${srv2.base}/api/store`, { headers: { 'X-Store-Token': 'bad' } })).status, 401);
  assert.equal((await fetch(`${srv2.base}/api/store`, { headers: { 'X-Store-Token': 'reset-ok' } })).status, 200);
});

test('增量日志持久化：服务端重启后 ?since=<rev> 仍命中增量变化', async t => {
  const dataDir = await makeDataDir();
  const srv1 = await startServer({ dataDir });
  const r1 = await (await fetch(`${srv1.base}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docs: [{ _id: 'c1', type: 'card', title: 'first', outline: '- a' }] })
  })).json();
  const r2 = await (await fetch(`${srv1.base}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_rev: r1.rev,
      mode: 'delta',
      docs: [{ _id: 'c2', type: 'card', title: 'second', outline: '- b', updated_at: '2026-02-01T00:00:00.000Z' }]
    })
  })).json();
  await srv1.close();

  assert.equal(fs.existsSync(path.join(dataDir, 'studystyle-delta.json')), true, '应生成 sidecar 增量日志');

  // 使用同一 dataDir 重启全新实例
  const srv2 = await startServer({ dataDir });
  t.after(() => srv2.close());
  const sinceRes = await (await fetch(`${srv2.base}/api/store?since=${encodeURIComponent(r1.rev)}`)).json();
  assert.equal(sinceRes.rev, r2.rev);
  assert.equal(sinceRes.incremental, true, '重启后 ?since=<rev> 不应退化为全量拉取');
  assert.equal(sinceRes.unchanged, false);
  assert.deepEqual(sinceRes.changes.map(d => d._id), ['c2']);
});

test('HTTP gzip 压缩传输大响应且 HEAD 不发空体异常', async t => {
  const http = require('node:http');
  const zlib = require('node:zlib');
  const srv = await startServer();
  t.after(() => srv.close());

  const bigDocs = Array.from({ length: 12 }, (_, i) => ({
    _id: `card:gz-${i}`,
    type: 'card',
    title: `压缩测试卡片 ${i}`,
    outline: '主动回忆 '.repeat(25)
  }));
  const putRes = await fetch(`${srv.base}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docs: bigDocs })
  });
  assert.equal(putRes.status, 200);

  const gzResp = await new Promise((resolve, reject) => {
    const req = http.request(`${srv.base}/api/store`, { headers: { 'Accept-Encoding': 'gzip' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(gzResp.status, 200);
  assert.equal(gzResp.headers['content-encoding'], 'gzip');
  assert.match(String(gzResp.headers.vary || ''), /Accept-Encoding/i);
  const decompressed = JSON.parse(zlib.gunzipSync(gzResp.raw).toString('utf8'));
  assert.equal(decompressed.docs.length, 12);

  const headResp = await fetch(`${srv.base}/api/store`, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(headResp.status, 200);
  assert.equal(headResp.headers.get('content-encoding'), null);
});

test('静态资源返回弱 ETag 与 no-cache，命中 If-None-Match 返回 304', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const first = await fetch(`${srv.base}/app.js`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.match(String(etag || ''), /^W\/"\d+-\d+"$/);
  assert.equal(first.headers.get('cache-control'), 'no-cache');

  const second = await fetch(`${srv.base}/app.js`, { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
  assert.equal(second.headers.get('etag'), etag);
  assert.equal(await second.text(), '');

  const apiRes = await fetch(`${srv.base}/api/store`);
  assert.equal(apiRes.headers.get('cache-control'), 'no-store');
});

test('trustProxy 开启后按 X-Forwarded-For 最右端真实代理 IP 隔离鉴权限流', async t => {
  const srv = await startServer({ storeToken: 'secret-tok', trustProxy: true, authFailLimit: 3, authWindowMs: 5000 });
  t.after(() => srv.close());

  // 同一攻击者不断伪造最左侧 IP，但直接相连反代追加的最右 IP (203.0.113.9) 不变
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${srv.base}/api/store`, {
      headers: {
        'X-Store-Token': 'wrong-tok',
        'X-Forwarded-For': `10.0.0.${i + 1}, 203.0.113.9`
      }
    });
    assert.equal(res.status, 401);
  }

  // 第 4 次即便换一个新的左端伪造 IP，仍须触发 429 限流
  const throttled = await fetch(`${srv.base}/api/store`, {
    headers: {
      'X-Store-Token': 'wrong-tok',
      'X-Forwarded-For': '9.9.9.9, 203.0.113.9'
    }
  });
  assert.equal(throttled.status, 429);

  // 另一个真实客户端 IP 不受同一 Caddy 网桥牵连，凭正确令牌正常放行
  const otherClient = await fetch(`${srv.base}/api/store`, {
    headers: {
      'X-Store-Token': 'secret-tok',
      'X-Forwarded-For': '198.51.100.7'
    }
  });
  assert.equal(otherClient.status, 200);
});

test('PUT /api/store 拒绝包含 __proto__/constructor/prototype 原型污染键的载荷', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const evilPayload = '{"docs":[{"_id":"card:evil","type":"card","title":"x","outline":"y","__proto__":{"polluted":"yes"}}]}';
  const res = await fetch(`${srv.base}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: evilPayload
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(String(body.error || ''), /非法原型键/);
  assert.equal(({}).polluted, undefined);
});

test('墓碑文档在落盘时自动裁剪冗余内容字段且保留删除元数据', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const res = await fetch(`${srv.base}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docs: [
        {
          _id: 'card:keep',
          type: 'card',
          title: '保留卡',
          outline: '- 核心要点',
          updated_at: '2026-02-01T00:00:00.000Z'
        },
        {
          _id: 'card:gone',
          _deleted: true,
          _rev: '2-deadbeef',
          type: 'card',
          title: '不应落盘的冗余标题',
          outline: '不应落盘的长大纲 '.repeat(40),
          recall_draft: '不应落盘的草稿',
          notebook: '高等数学',
          updated_at: '2026-02-02T00:00:00.000Z',
          deleted_at: '2026-02-02T00:00:00.000Z'
        }
      ]
    })
  });
  assert.equal(res.status, 200);

  const onDisk = JSON.parse(await fsp.readFile(srv.storeFile, 'utf8'));
  const tombstone = onDisk.docs.find(d => d._id === 'card:gone');
  const live = onDisk.docs.find(d => d._id === 'card:keep');
  assert.deepEqual(tombstone, {
    _id: 'card:gone',
    _deleted: true,
    _rev: '2-deadbeef',
    updated_at: '2026-02-02T00:00:00.000Z',
    deleted_at: '2026-02-02T00:00:00.000Z'
  });
  assert.equal(live.title, '保留卡');
  assert.equal(live.outline, '- 核心要点');
});

test('read 缓存命中时正常返回 ?since= 且外部改写或损坏磁盘文件立即失效', async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const putRes = await fetch(`${srv.base}/api/store`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docs: [{ _id: 'card:cache-1', type: 'card', title: '缓存初始卡', outline: '- a' }]
    })
  });
  assert.equal(putRes.status, 200);
  const { rev: rev1 } = await putRes.json();

  // 1) 同版本与 r0 增量查询（命中内存快照缓存）
  const sameRes = await fetch(`${srv.base}/api/store?since=${encodeURIComponent(rev1)}`);
  assert.equal(sameRes.status, 200);
  const sameBody = await sameRes.json();
  assert.equal(sameBody.incremental, true);
  assert.equal(sameBody.unchanged, true);
  assert.equal(sameBody.rev, rev1);

  const deltaRes = await fetch(`${srv.base}/api/store?since=r0`);
  assert.equal(deltaRes.status, 200);
  const deltaBody = await deltaRes.json();
  assert.equal(deltaBody.incremental, true);
  assert.equal(deltaBody.changes.some(d => d._id === 'card:cache-1'), true);

  // 2) 外部直接改写磁盘上的 studystyle-db.json 后，下一次读取必须失效缓存
  await fsp.writeFile(srv.storeFile, JSON.stringify({
    app: 'StudyStyle',
    updated_at: '2026-03-01T00:00:00.000Z',
    rev: 'r99',
    docs: [{ _id: 'card:ext-edit', type: 'card', title: '外部直接替换后的卡片内容-确保长度变化' }]
  }), 'utf8');

  const afterExternalRes = await fetch(`${srv.base}/api/store?since=${encodeURIComponent(rev1)}`);
  assert.equal(afterExternalRes.status, 200);
  const afterExternalBody = await afterExternalRes.json();
  assert.equal(afterExternalBody.rev, 'r99');
  assert.equal(afterExternalBody.incremental, false);
  assert.equal(afterExternalBody.docs.some(d => d._id === 'card:ext-edit'), true);

  // 3) 外部把磁盘文件写坏后，读请求必须感知并隔离坏文件返回 500，绝不能返吐旧缓存
  await fsp.writeFile(srv.storeFile, '{corrupt-json', 'utf8');
  const corruptRes = await fetch(`${srv.base}/api/store`);
  assert.equal(corruptRes.status, 500);
  const files = await fsp.readdir(srv.dataDir);
  assert.ok(files.some(name => name.startsWith('studystyle-db.json.corrupt.')));
});

test('服务端 CouchDB 代理支持反代子路径、清洗 URL 参数并拒绝系统保留库名', async t => {
  const { createServer: createHttpServer } = require('node:http');
  const seen = [];
  const mockCouch = createHttpServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise(r => mockCouch.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => mockCouch.close(r)));
  const couchPort = mockCouch.address().port;

  // 1) COUCH_PROXY_URL 带查询参数/锚点 + 子路径前缀 + 显式 COUCH_PROXY_DB 时应剥离噪声并保留子路径
  const srvSubpath = await startServer({
    couchProxyUrl: `http://127.0.0.1:${couchPort}/couch/?ignored=1#hash`,
    couchProxyDb: 'my_notes'
  });
  t.after(() => srvSubpath.close());
  const st = await (await fetch(`${srvSubpath.base}/api/couch/status`)).json();
  assert.deepEqual({ enabled: st.enabled, db: st.db }, { enabled: true, db: 'my_notes' });
  const r = await fetch(`${srvSubpath.base}/api/couch/db/my_notes/doc-sub`);
  assert.equal(r.status, 200);
  assert.equal(seen[0], '/couch/my_notes/doc-sub');

  // 2) 非法保留库名（如 _users）必须自动禁用代理而非暴露系统库
  const srvReserved = await startServer({
    couchProxyUrl: `http://127.0.0.1:${couchPort}`,
    couchProxyDb: '_users'
  });
  t.after(() => srvReserved.close());
  const reservedStatus = await (await fetch(`${srvReserved.base}/api/couch/status`)).json();
  assert.equal(reservedStatus.enabled, false);
  const reservedProxy = await fetch(`${srvReserved.base}/api/couch/db/_users/doc1`);
  assert.equal(reservedProxy.status, 503);
});
