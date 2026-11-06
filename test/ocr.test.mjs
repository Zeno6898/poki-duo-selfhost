import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { root } from '../src/config.mjs';

const run = promisify(execFile);
const helper = join(root, 'build/ocr');
const pngFixture = join(root, 'test/fixtures/ocr-zh-en.png');
const expected = JSON.parse(await readFile(join(root, 'test/fixtures/ocr-zh-en.json'), 'utf8')).lines;
const keys = ['confidence', 'height', 'text', 'width', 'x', 'y'];
const python = ['python3', 'python'].find(p => spawnSync(p, ['--version']).status === 0);
const built = await access(helper, constants.X_OK).then(() => true, () => false);
const squash = s => s.replace(/\s+/g, '');

test('native/ocr.py turns engine quads into build/ocr elements', { skip: !python && 'needs Python 3' }, () => {
  // Stdlib only: the engine import happens inside main(), so this runs without RapidOCR.
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ocr', sys.argv[1])
ocr = importlib.util.module_from_spec(spec); spec.loader.exec_module(ocr)
quads = [[[10, 20], [110, 18], [112, 50], [12, 52]], [[-3, 5], [40, 5], [40, 9], [-3, 9]], [[0, 0], [1, 0], [1, 1], [0, 1]]]
print(ocr.dump(ocr.to_elements(quads, ['设置 Settings', 'edge', ''], [0.9, 0.5, 0.1])))`;
  const out = spawnSync(python, ['-I', '-B', '-c', script, join(root, 'native/ocr.py')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.trim(), '[{"confidence":0.9,"height":34.0,"text":"设置 Settings","width":102.0,"x":10.0,"y":18.0},{"confidence":0.5,"height":4.0,"text":"edge","width":40.0,"x":0.0,"y":5.0}]');
});

test('native/ocr.py rejects a missing image the way the Swift helper does', { skip: !python && 'needs Python 3' }, () => {
  for (const args of [[], [join(root, 'test/fixtures/does-not-exist.png')], [join(root, 'package.json')]]) {
    const out = spawnSync(python, ['-I', '-B', join(root, 'native/ocr.py'), ...args], { encoding: 'utf8' });
    assert.equal(out.status, 1);
    assert.equal(out.stdout, '');
    assert.match(out.stderr, /^Expected a readable image path\n$/);
  }
});

test('build/ocr reads the Chinese and English fixture', { skip: !built && 'build/ocr is not built (bin/build-native)' }, async () => {
  const { stdout } = await run(helper, [pngFixture], { encoding: 'utf8', timeout: 120_000 });
  const elements = JSON.parse(stdout);
  assert.ok(Array.isArray(elements));
  for (const e of elements) {
    assert.deepEqual(Object.keys(e).sort(), keys);
    assert.equal(typeof e.text, 'string');
    for (const k of keys.filter(k => k !== 'text')) assert.ok(Number.isFinite(e[k]) && e[k] >= 0, `${k} = ${e[k]}`);
    assert.ok(e.confidence <= 1);
    assert.ok(e.x + e.width <= 640 && e.y + e.height <= 480, JSON.stringify(e));
  }
  const text = elements.map(e => squash(e.text)).join('\n');
  for (const line of expected) for (const word of line.split(' ')) assert.ok(text.includes(squash(word)), `missing "${word}" in ${stdout}`);
  const top = expected.map(line => elements.find(e => squash(e.text).includes(squash(line.split(' ')[0])))?.y);
  assert.deepEqual([...top].sort((a, b) => a - b), top, 'lines come back top to bottom with a top-left origin');
});
