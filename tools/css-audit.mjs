import { readFileSync } from 'node:fs';
const app = readFileSync('app.js', 'utf8');
const css = readFileSync('styles.css', 'utf8');
const cls = new Set();
const re = /class="([^"]*)"/g;
let m;
while ((m = re.exec(app))) {
  m[1].split(/\s+/).forEach((c) => {
    if (c && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(c)) cls.add(c);
  });
}
const cssClasses = new Set();
const cre = /\.(-?[_a-zA-Z][\w-]*)/g;
while ((m = cre.exec(css))) cssClasses.add(m[1]);
const missing = [...cls].filter((c) => !cssClasses.has(c));
console.log('used:', cls.size, '| missing:', missing.length);
console.log(missing.sort().join(' '));
