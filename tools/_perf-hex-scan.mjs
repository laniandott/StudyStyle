// 扫描 styles.css，统计「变量块之外」的硬编码 hex
import fs from 'node:fs';

const file = process.argv[2] || 'F:/projects/StudyStyle/styles.css';
const src = fs.readFileSync(file, 'utf8');
const lines = src.split(/\r?\n/);

// 标记变量块内部（以 { 开头的块中，声明形如 --x: value; 的行）
let inBlock = false;
let blockDepth = 0;
const inVarBlock = new Array(lines.length).fill(false);
const varBlockRanges = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!inBlock && /^\s*\{/.test(line)) { inBlock = true; blockDepth = 1; varBlockRanges.push({ start: i, end: null }); continue; }
  if (inBlock) {
    blockDepth += (line.match(/\{/g) || []).length;
    blockDepth -= (line.match(/\}/g) || []).length;
    if (blockDepth <= 0) { inBlock = false; varBlockRanges[varBlockRanges.length - 1].end = i; continue; }
  }
  const trimmed = line.trim();
  if (/^--[a-zA-Z0-9_-]+\s*:/.test(trimmed) || (inBlock && trimmed.startsWith('--'))) {
    inVarBlock[i] = true;
  }
}

const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
const offenders = [];
for (let i = 0; i < lines.length; i++) {
  if (inVarBlock[i]) continue;
  const m = lines[i].match(hexRe);
  if (m) offenders.push({ line: i + 1, text: lines[i].trim(), hexes: m });
}

console.log('变量块行数统计:', inVarBlock.filter(Boolean).length);
console.log('=== 变量块之外的 hex 出现行 ===');
for (const o of offenders) console.log(`${o.line}\t${o.hexes.join(',')}\t${o.text}`);
console.log('总行数:', offenders.length);
