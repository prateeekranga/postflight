import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const cliBin = path.join(repoRoot, 'packages/cli/dist/index.js');

function runCliProc(args) {
  try {
    const stdout = execFileSync(process.execPath, [cliBin, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

describe('@postflight/cli — Integration Tests', () => {
  it('passes check on clean launch campaign and outputs valid JSON & SARIF 2.1.0', () => {
    const ok = runCliProc(['check', 'examples/campaigns/launch-announcement.md', '--format', 'json']);
    assert.equal(ok.code, 0, `Expected exit 0, stderr: ${ok.stderr}`);
    const parsed = JSON.parse(ok.stdout);
    assert.equal(parsed.passed, true);

    const sarifRes = runCliProc(['check', 'examples/campaigns/launch-announcement.md', '--format', 'sarif']);
    assert.equal(sarifRes.code, 0);
    const sarif = JSON.parse(sarifRes.stdout);
    assert.equal(sarif.version, '2.1.0');
  });

  it('exits non-zero on broken sponsored campaign with FTC/hashtag/Unicode failures', () => {
    const fail = runCliProc(['check', 'examples/campaigns/sponsored-promo-broken.md', '--format', 'json']);
    assert.equal(fail.code, 1);
    const parsed = JSON.parse(fail.stdout);
    assert.equal(parsed.passed, false);
    assert.ok(parsed.totalErrors > 0);
  });

  it('compiles canonical post, audits safezone/utm/triage/ffmpeg/tokens/contrast, and verifies killswitch chain', () => {
    const comp = runCliProc(['compile', 'examples/campaigns/canonical-thread-source.md', '--format', 'json']);
    assert.equal(comp.code, 0);
    const bundle = JSON.parse(comp.stdout);
    assert.ok(bundle.artifacts.length >= 4);
    const xArt = bundle.artifacts.find((a) => a.platform === 'x');
    assert.ok(xArt && xArt.posts.length >= 2, 'Expected X compiler to auto-thread long canonical post');

    const szFail = runCliProc(['safezone', '--preset', 'tiktok-ad', '--box', '800,950,200,150:CTA', '--format', 'json']);
    assert.equal(szFail.code, 1);
    assert.equal(JSON.parse(szFail.stdout).allClear, false);

    const szPass = runCliProc(['safezone', '--preset', 'tiktok-ad', '--box', '200,400,400,200:Title', '--format', 'json']);
    assert.equal(szPass.code, 0);
    assert.equal(JSON.parse(szPass.stdout).allClear, true);

    const utmDirty = runCliProc([
      'utm',
      '--url',
      'https://postflight.dev/?utm_source=LinkedIn&fbclid=123',
      '--platform',
      'linkedin',
      '--campaign',
      'launch',
      '--format',
      'json',
    ]);
    assert.equal(utmDirty.code, 1);
    const utmDirtyData = JSON.parse(utmDirty.stdout);
    assert.equal(utmDirtyData.hasClickIdNoise, true);
    assert.ok(utmDirtyData.canonicalUrl.includes('utm_source=linkedin'));

    const utmClean = runCliProc([
      'utm',
      '--url',
      'https://postflight.dev/?utm_source=linkedin&utm_medium=organic-social&utm_campaign=launch',
      '--platform',
      'linkedin',
      '--format',
      'json',
    ]);
    assert.equal(utmClean.code, 0);

    const triage = runCliProc(['triage', 'examples/comments-sample.json', '--format', 'json']);
    assert.equal(triage.code, 0);
    const triaged = JSON.parse(triage.stdout);
    assert.equal(triaged[0].intent, 'crisis-urgent');

    const ff = runCliProc(['ffmpeg', '--platform', 'instagram-reels', '--hdr', '--format', 'json']);
    assert.equal(ff.code, 0);
    assert.ok(JSON.parse(ff.stdout).command.includes('+faststart'));

    const contrast = runCliProc(['contrast', '--fg', '#141920', '--bg', '#F6F4EE', '--format', 'json']);
    assert.equal(contrast.code, 0);
    assert.equal(JSON.parse(contrast.stdout).aaNormal, true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postflight-ks-'));
    try {
      const frz = runCliProc(['killswitch', 'freeze', '--actor', 'ci-test', '--reason', 'Drill', '--dir', tmpDir]);
      assert.equal(frz.code, 0);
      const ver = runCliProc(['killswitch', 'verify', '--dir', tmpDir]);
      assert.equal(ver.code, 0);
      const res = runCliProc(['killswitch', 'resume', '--actor', 'ci-test', '--reason', 'Clear', '--dir', tmpDir]);
      assert.equal(res.code, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('killswitch verify rejects a ledger whose history has been edited', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postflight-ks-tamper-'));
    const ledgerPath = path.join(tmpDir, '.postflight', 'killswitch.json');
    try {
      assert.equal(runCliProc(['killswitch', 'freeze', '--actor', 'ci-test', '--reason', 'Outage', '--dir', tmpDir]).code, 0);
      assert.equal(runCliProc(['killswitch', 'resume', '--actor', 'ci-test', '--reason', 'Resolved', '--dir', tmpDir]).code, 0);
      assert.equal(runCliProc(['killswitch', 'freeze', '--actor', 'ci-test', '--reason', 'Brand hold', '--dir', tmpDir]).code, 0);

      const intact = runCliProc(['killswitch', 'verify', '--dir', tmpDir, '--format', 'json']);
      assert.equal(intact.code, 0, `Expected intact ledger to verify, stderr: ${intact.stderr}`);
      assert.deepEqual(JSON.parse(intact.stdout).chain, { valid: true, brokenAtSeq: null });

      const original = fs.readFileSync(ledgerPath, 'utf8');
      const ledger = JSON.parse(original);
      assert.equal(ledger.auditLog.length, 3);

      // Rewrite who resumed publishing, leaving the stored hashes untouched.
      ledger.auditLog[1].actor = 'someone-else';
      fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');

      const tampered = runCliProc(['killswitch', 'verify', '--dir', tmpDir, '--format', 'json']);
      assert.equal(tampered.code, 1, 'Expected verify to exit 1 on a tampered ledger');
      assert.deepEqual(JSON.parse(tampered.stdout).chain, { valid: false, brokenAtSeq: 2 });

      const pretty = runCliProc(['killswitch', 'verify', '--dir', tmpDir]);
      assert.equal(pretty.code, 1);
      assert.match(pretty.stdout, /BROKEN at seq #2/);

      // Deleting an entry from the middle of the history is also rejected.
      const truncated = JSON.parse(original);
      truncated.auditLog.splice(1, 1);
      fs.writeFileSync(ledgerPath, `${JSON.stringify(truncated, null, 2)}\n`, 'utf8');
      const deleted = runCliProc(['killswitch', 'verify', '--dir', tmpDir, '--format', 'json']);
      assert.equal(deleted.code, 1, 'Expected verify to exit 1 when an entry is removed');
      assert.equal(JSON.parse(deleted.stdout).chain.valid, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
