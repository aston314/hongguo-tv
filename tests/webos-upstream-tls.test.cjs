'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { X509Certificate } = require('node:crypto');
const { spawn } = require('node:child_process');
const https = require('node:https');
const service = path.join(__dirname, '../webos/service');
const source = fs.readFileSync(path.join(service, 'upstream-tls.js'), 'utf8');
const cert = fs.readFileSync(path.join(service, 'certs/digicert-global-root-g2.pem'), 'utf8');
function policy(version) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require, __dirname: service, process: { versions: { node: version } } });
  return module.exports;
}
test('legacy CA matches official DigiCert fingerprint; domain and runtime scope remain narrow', () => {
  const x509 = new X509Certificate(cert);
  assert.equal(x509.fingerprint256.replaceAll(':', ''), 'CB3CCBB76031E5E0138F8DD39A23F9DE47FFC35E43C1144CEA27D46A5AB1CB5F');
  assert(x509.ca && x509.verify(x509.publicKey));
  const legacy = policy('0.12.2');
  for (const hostname of ['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-sinfonlinea.fqnovel.com', 'api5-normal-hl.fqnovel.com', 'api5-normal-lq.fqnovel.com', 'log.snssdk.com', 'hongguoduanju.com']) {
    const original = { protocol: 'https:', hostname, path: '/private?token=secret', headers: { Cookie: 'synthetic' } };
    const next = legacy(original);
    assert.equal(next.ca[0], cert); assert.equal(next.rejectUnauthorized, true);
    assert.equal(next.checkServerIdentity, undefined, 'keep native hostname verification');
    assert.equal(original.ca, undefined); assert.equal(next.headers, original.headers);
    for (const version of ['8.12.0', '20.0.0', process.versions.node]) assert.equal(policy(version)(original), original);
    const plain = { ...original, protocol: 'http:' }; assert.equal(legacy(plain), plain);
  }
  for (const hostname of ['api5-normal-sinfonlineb.fqnovel.com.evil.invalid', 'sub.hongguoduanju.com', 'raw.githubusercontent.com', 'gh-proxy.com', '127.0.0.1']) {
    const original = { protocol: 'https:', hostname }; assert.equal(legacy(original), original);
  }
});

for (const runtime of [...new Set([process.execPath, process.env.WEBOS_LEGACY_NODE].filter(Boolean))]) {
  test('TLS verification remains enabled with ' + runtime, async () => {
    const fixtures = path.join(__dirname, 'fixtures/webos-tls');
    const key = fs.readFileSync(path.join(fixtures, 'server-key.pem'));
    const servers = ['server', 'expired'].map((name) => https.createServer({
      key, cert: fs.readFileSync(path.join(fixtures, name + '.pem')), minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2'
    }, (req, res) => { res.statusCode = Number(req.url.slice(1)); res.end('test'); }));
    try {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
      await new Promise((resolve, reject) => {
        const child = spawn(runtime, [path.join(__dirname, 'fixtures/webos-legacy-tls-probe.cjs')], {
          env: { ...process.env, WEBOS_TEST_TLS_PORT: String(servers[0].address().port), WEBOS_TEST_TLS_EXPIRED_PORT: String(servers[1].address().port) }
        });
        let output = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('TLS child timed out')); }, 12000);
        child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
        child.on('error', reject);
        child.on('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(output)); });
      });
    } finally { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); }
  });
}
