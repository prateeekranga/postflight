import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/index.js');
function run(input, format, ...flags) {
  const result = spawnSync(process.execPath, [cli, 'check', input, '--format', format, ...flags], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.error, undefined);
  return { code: result.status, text: result.stdout, stderr: result.stderr };
}

describe('check --quiet', () => {
  const broken = 'examples/campaigns/sponsored-promo-broken.md';
  it('filters JSON diagnostics while preserving errors, totals and exit status', () => {
    const normal = run(broken, 'json');
    const quiet = run(broken, 'json', '--quiet');
    const before = JSON.parse(normal.text);
    const after = JSON.parse(quiet.text);
    assert.ok(before.totalErrors > 0);
    assert.ok(before.totalWarnings + before.totalInfos > 0);
    assert.equal(quiet.code, normal.code);
    assert.equal(after.totalWarnings, before.totalWarnings);
    assert.equal(after.totalInfos, before.totalInfos);
    for (let i = 0; i < before.platforms.length; i++) {
      assert.deepEqual(after.platforms[i].diagnostics,
        before.platforms[i].diagnostics.filter(d => d.severity === 'error'));
    }
    assert.equal(after.autoFixPreview, undefined);
  });

  it('filters warning and info messages in pretty, markdown and SARIF reports', () => {
    const baseline = JSON.parse(run(broken, 'json').text);
    const hidden = baseline.platforms.flatMap(p => p.diagnostics).filter(d => d.severity !== 'error');
    for (const format of ['pretty', 'markdown', 'sarif']) {
      const result = run(broken, format, '--quiet');
      assert.equal(result.code, 1, result.stderr);
      for (const diagnostic of hidden) {
        assert.ok(!result.text.includes(diagnostic.message), `${format}: ${diagnostic.ruleId}`);
      }
      if (format === 'sarif') {
        const results = JSON.parse(result.text).runs[0].results;
        assert.ok(results.length > 0);
        assert.ok(results.every(r => r.level === 'error'));
      }
    }
  });

  it('keeps warning-only strict checks failing and suppresses directory advisories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postflight-quiet-'));
    try {
      // An outbound-link warning without blocking errors; duplicate files also exercise directory advisories.
      const text = '---\ntargets: [linkedin]\n---\nHello world. Read https://example.com/update\n';
      fs.writeFileSync(path.join(dir, 'a.md'), text);
      fs.writeFileSync(path.join(dir, 'b.md'), text);
      const input = path.join(dir, 'a.md');
      const normal = run(input, 'json', '--strict');
      const original = JSON.parse(normal.text);
      assert.equal(original.totalErrors, 0);
      assert.ok(original.totalWarnings > 0);
      const quiet = run(input, 'json', '--strict', '--quiet');
      assert.equal(quiet.code, 1);
      assert.ok(JSON.parse(quiet.text).platforms.every(p => p.diagnostics.length === 0));
      const folder = run(dir, 'json', '--quiet', '--strict');
      assert.equal(folder.code, 1);
      const report = JSON.parse(folder.text);
      assert.equal(report.fileCount, 2);
      assert.deepEqual(report.duplicates, []);
      assert.ok(report.files.every(f => f.report.platforms.every(p => p.diagnostics.length === 0)));
      const out = path.join(dir, 'report.json');
      const written = run(input, 'json', '--quiet', '--out', out);
      assert.equal(written.code, 0);
      assert.equal(written.text, '');
      assert.ok(JSON.parse(fs.readFileSync(out, 'utf8')).platforms.every(p => p.diagnostics.length === 0));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still applies the same fixes while hiding fix descriptions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postflight-quiet-fix-'));
    try {
      const normalFile = path.join(dir, 'normal.md');
      const quietFile = path.join(dir, 'quiet.md');
      const source = fs.readFileSync(path.join(root, broken), 'utf8');
      fs.writeFileSync(normalFile, source);
      fs.writeFileSync(quietFile, source);
      const normal = run(normalFile, 'json', '--fix');
      const quiet = run(quietFile, 'json', '--fix', '--quiet');
      const before = JSON.parse(normal.text);
      const after = JSON.parse(quiet.text);
      assert.equal(before.fixed, true);
      assert.ok(before.appliedFixes.length > 0);
      assert.equal(after.fixed, true);
      assert.deepEqual(after.appliedFixes, []);
      assert.equal(quiet.code, normal.code);
      assert.notEqual(fs.readFileSync(quietFile, 'utf8'), source);
      assert.equal(fs.readFileSync(quietFile, 'utf8'), fs.readFileSync(normalFile, 'utf8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
