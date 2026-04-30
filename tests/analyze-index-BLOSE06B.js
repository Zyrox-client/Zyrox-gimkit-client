const fs = require('fs');
const path = require('path');

const candidatePaths = [
  process.argv[2],
  'assets/play/index-BLOSE06B.js',
  'debug/index-BLOSE06B.js'
].filter(Boolean);

const bundlePath = candidatePaths.find(p => fs.existsSync(p));
if (!bundlePath) {
  console.error(JSON.stringify({
    error: 'Bundle not found in expected locations',
    checked: candidatePaths
  }, null, 2));
  process.exit(1);
}

const src = fs.readFileSync(bundlePath, 'utf8');
const depMatch = src.match(/m\.f = \[(.*?)\]\)\)\) =>/s);
const deps = depMatch ? [...depMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];
const keys = ['question', 'questions', 'currentQuestion', 'shuffle', 'socket', 'websocket', 'random'];
const counts = Object.fromEntries(keys.map(k => [k, (src.match(new RegExp(k, 'gi')) || []).length]));

console.log(JSON.stringify({
  bundlePath: path.normalize(bundlePath),
  lineCount: src.split('\n').length,
  depsCount: deps.length,
  questionDeps: deps.filter(d => /Question|GimkitLiveQuestion/i.test(d)),
  counts
}, null, 2));
