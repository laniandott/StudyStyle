import { createServer } from 'node:http';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const storeFile = join(dataDir, 'studystyle-db.json');

const publicFiles = new Set(['index.html', 'styles.css', 'app.js', 'domain.cjs', 'favicon.svg', 'icon.svg']);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

async function readStoreDocs() {
  try {
    const raw = await readFile(storeFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.docs) ? parsed.docs : (Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

let writeChain = Promise.resolve();
function writeStoreDocs(docs) {
  writeChain = writeChain.catch(() => {}).then(async () => {
    await mkdir(dataDir, { recursive: true });
    const tmpFile = `${storeFile}.tmp`;
    const payload = JSON.stringify({ app: 'StudyStyle', updated_at: new Date().toISOString(), docs }, null, 2);
    await writeFile(tmpFile, payload, 'utf8');
    await rename(tmpFile, storeFile);
  });
  return writeChain;
}

function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        rejectBody(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveBody(text ? JSON.parse(text) : {});
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    if (pathname === '/api/store') {
      if (req.method === 'GET') {
        const docs = await readStoreDocs();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, docs }));
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readJsonBody(req);
        const docs = Array.isArray(body?.docs) ? body.docs : [];
        await writeStoreDocs(docs);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, count: docs.length }));
        return;
      }
    }

    const requestedFile = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (requestedFile.includes('/') || !publicFiles.has(requestedFile)) throw new Error('not a public asset');
    const candidate = resolve(root, requestedFile);
    if (!(await stat(candidate)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': mime[extname(candidate)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(candidate));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

const port = Number(process.env.PORT || 3880);
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`StudyStyle is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (data: ${dataDir})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
