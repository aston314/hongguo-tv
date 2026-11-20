'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

for (const runtime of [...new Set([process.execPath, process.env.WEBOS_LEGACY_NODE].filter(Boolean))]) {
  test('packaged webOS service runs with ' + runtime, () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-runtime-'));
    try {
      const child = spawnSync(runtime, [path.join(__dirname, 'fixtures/webos-legacy-service-probe.cjs')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 18000,
        env: { ...process.env, HONGGUO_WEBOS_DATA_DIR: dataDir }
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.match(child.stdout, /bootstrap, signing, HTTP health\/status and shutdown PASS/);
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
}
