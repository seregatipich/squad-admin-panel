import { readFileSync, writeFileSync } from 'node:fs';
import { parseLine } from '../src/parser/patterns.ts';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error('usage: render-baseline.ts <input.log> <output.json>');
}
const lines = readFileSync(input, 'utf8').split(/\r?\n/);
const parsed = lines
  .map((line, i) => ({ i, line, parsed: parseLine(line) }))
  .filter((r) => r.parsed !== null);
writeFileSync(output, JSON.stringify(parsed, null, 2));
console.log('lines:', lines.length, 'parsed:', parsed.length);
