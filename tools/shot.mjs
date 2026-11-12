// 轻量 CDP 截图器：Node 22 内置 WebSocket，无需额外依赖
// 用法: node shot.js <url> <outPng> <width> <height> [evalFile] [extraMs]
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, wStr, hStr, evalFile, extraMs, evalFile2] = process.argv.slice(2);
const width = Number(wStr) || 1440;
const height = Number(hStr) || 900;

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = mkdtempSync(join(tmpdir(), 'ss-cdp-'));
const browser = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  '--remote-debugging-port=9222', `--user-data-dir=${profile}`,
  '--window-size=' + width + ',' + height, 'about:blank',
], { stdio: 'ignore', detached: false });

async function cdpList() {
  const res = await fetch('http://127.0.0.1:9222/json/list');
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('open', () => resolve({ send, events, close: () => ws.close() }));
    ws.addEventListener('error', (e) => reject(new Error('ws error ' + (e.message || ''))));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? j(new Error(JSON.stringify(msg.error))) : r(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
    function send(method, params = {}) {
      const mid = ++id;
      return new Promise((r, j) => {
        pending.set(mid, { resolve: r, reject: j });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let target = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await cdpList();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) throw new Error('no CDP target');

  const c = await connect(target.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: width < 700,
  });
  await c.send('Page.navigate', { url });
  await sleep(1200);
  try { await c.send('Runtime.evaluate', { expression: 'document.fonts && document.fonts.ready' , awaitPromise: true}); } catch {}

  if (evalFile) {
    const expr = readFileSync(evalFile, 'utf8');
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.error('EVAL ERROR:', JSON.stringify(r.exceptionDetails).slice(0, 600));
    else if (r.result && r.result.value !== undefined) console.error('EVAL:', JSON.stringify(r.result.value).slice(0, 600));
    await sleep(500);
    // 重新导航，让应用重新读取注入的数据
    await c.send('Page.navigate', { url });
    await sleep(1400);
  }
  await sleep(Number(extraMs || 400));

  if (evalFile2) {
    const expr2 = readFileSync(evalFile2, 'utf8');
    const r2 = await c.send('Runtime.evaluate', { expression: expr2, awaitPromise: true, returnByValue: true });
    if (r2.exceptionDetails) console.error('EVAL2 ERROR:', JSON.stringify(r2.exceptionDetails).slice(0, 500));
    else if (r2.result && r2.result.value !== undefined) console.error('EVAL2:', JSON.stringify(r2.result.value).slice(0, 300));
    await sleep(Number(extraMs || 400) + 600);
  }

  const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out);
  c.close();
  try { process.kill(browser.pid); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
main().catch((e) => {
  console.error('FAIL', e.message);
  try { process.kill(browser.pid); } catch {}
  process.exit(1);
});
