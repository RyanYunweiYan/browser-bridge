#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATTERNS_DIR = path.join(ROOT, 'references', 'site-patterns');
const query = (process.argv[2] || '').trim();

if (!query || !fs.existsSync(PATTERNS_DIR)) process.exit(0);

for (const file of fs.readdirSync(PATTERNS_DIR)) {
  if (!file.endsWith('.md')) continue;

  const domain = file.replace(/\.md$/, '');
  const content = fs.readFileSync(path.join(PATTERNS_DIR, file), 'utf-8');

  const aliasMatch = content.match(/^aliases:\s*\[([^\]]*)\]/m);
  const aliases = aliasMatch
    ? aliasMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const patterns = [domain, ...aliases].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!new RegExp(patterns.join('|'), 'i').test(query)) continue;

  const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
  const body = fmEnd >= 0 ? content.slice(fmEnd + 3).trim() : content;
  console.log(`--- Site experience: ${domain} ---`);
  console.log(body);
  console.log();
}
