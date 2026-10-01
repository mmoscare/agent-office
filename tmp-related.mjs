import { relatedTests } from './src/server/vp-verify.ts';
import { readFileSync } from 'node:fs';
const changed = readFileSync(0, 'utf8').trim().split(/\r?\n/).filter(Boolean);
const files = relatedTests(process.cwd(), changed);
console.log(files.join('\n'));
