import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const fixture = 'examples/campaigns/launch-announcement.md';

function runCliProc(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cliBin, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    };
  }
}

describe('@postflight/cli - NO_COLOR and non-TTY output', () => {
  it('produces no ANSI codes when stdout is piped', () => {
    const res = runCliProc(['check', fixture]);
    assert.equal(res.code, 0, `Expected exit 0, stderr: ${res.stderr}`);
    assert.ok(!res.stdout.includes('\u001b'), 'Expected piped output to contain no ANSI escape codes');
  });

  it('produces no ANSI codes with NO_COLOR set', () => {
    const res = runCliProc(['check', fixture], { NO_COLOR: '1' });
    assert.equal(res.code, 0, `Expected exit 0, stderr: ${res.stderr}`);
    assert.ok(!res.stdout.includes('\u001b'), 'Expected NO_COLOR output to contain no ANSI escape codes');
  });

  it('keeps ANSI codes on stdout when colour is forced', () => {
    const res = runCliProc(['check', fixture], { FORCE_COLOR: '1' });
    assert.equal(res.code, 0, `Expected exit 0, stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('\u001b'), 'Expected forced-colour output to contain ANSI escape codes');
  });

  it('writes plain output to --out files even when colour is forced', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postflight-no-color-'));
    try {
      const outFile = path.join(tmpDir, 'report.txt');
      const res = runCliProc(['check', fixture, '--out', outFile], { FORCE_COLOR: '1' });
      assert.equal(res.code, 0, `Expected exit 0, stderr: ${res.stderr}`);
      const written = fs.readFileSync(outFile, 'utf8');
      assert.ok(!written.includes('\u001b'), 'Expected --out file to contain no ANSI escape codes');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
