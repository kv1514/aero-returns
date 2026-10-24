import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// vinext 1.0.0-beta.5: a next/link click throws inside startTransition and the page never navigates
// (reproduced on the deployed Worker, Oct 24). Internal links must be plain <a href>.
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.(tsx?|jsx?)$/.test(name) ? [path] : [];
});

test('no component or page imports next/link', () => {
  const offenders = ['app', 'components', 'lib'].flatMap(files).filter(path => /from\s+['"]next\/link['"]/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, []);
});
