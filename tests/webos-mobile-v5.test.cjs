'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const signer = require('../webos/service/playback-v5-sign');
const carrier = require('../webos/service/playback-v5-carrier');
const profile = require('../webos/service/mobile-playback-v5');
const passport = require('../webos/service/passport-sign');
const cancel = require('../webos/service/audio-cancel');
const vectors = (name) => require('../core/cmd/hongguotv/testdata/signing-v5-' + name + '.json');
const device = { deviceID: '123', installID: '456', cdid: 'synthetic' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('v5 matches independent F13, carrier and current protocol wire vectors', () => {
  assert.equal(vectors('f13').length, 32);
  for (const v of vectors('f13'))
    assert.equal(
      signer
        .f13(Buffer.from(v.query, 'hex'), Buffer.from(v.body, 'hex'), v.ts)
        .slice(0, 16)
        .toString('hex'),
      v.digest
    );
  assert.equal(vectors('carrier').length, 4);
  for (const v of vectors('carrier'))
    assert.equal(
      carrier(
        Buffer.from(v.source, 'hex'),
        v.ts,
        Buffer.from(v.key, 'hex'),
        Buffer.from(v.iv, 'hex')
      ).toString('hex'),
      v.encrypted
    );
  assert.equal(vectors('wire').length, 4);
  for (const v of vectors('wire')) {
    const values = profile.query(device),
      tuned = signer.tune(values, Buffer.from(v.body, 'hex'), v.ts * 1000);
    assert.equal(tuned.query, v.query);
    assert.equal(
      signer.medusa(values, v.ts, tuned.q, tuned.m, [0x80000000, 0x80000000, 0x80000000], {
        nonce: 'synthetic',
        started: 1800000000000
      }),
      v.medusa
    );
    assert.equal(signer.helios(v.ts, 0x80000000), v.helios);
  }
});

test('v5 signs the actual gzip bytes and binds timestamp, identity and selected episode', () => {
  for (const type of ['1004', '1003']) {
    const r = profile.build('123', type, device, 1800000000000),
      u = new URL(r.url);
    const body = JSON.parse(zlib.gunzipSync(r.body));
    assert.deepEqual(body.mixed_video_id_map, { [type]: ['123'] });
    assert.equal(body.dr_scene, 'player');
    assert.equal(u.searchParams.get('manifest_version_code'), '74332');
    assert.equal(body.biz_param.device_level, 1);
    assert.equal(body.biz_param.video_platform, 1024);
    assert.equal(r.headers['Content-Encoding'], 'gzip');
    assert.equal(r.headers['X-Khronos'], '1800000000');
    assert.equal(
      r.headers['X-SS-STUB'],
      crypto.createHash('md5').update(r.body).digest('hex').toUpperCase()
    );
    assert.equal(passport.branch(u.search.slice(1), r.body, 1800000000).iv & 15, 12);
    assert.equal(u.searchParams.get('device_id'), '123');
    assert.equal(u.searchParams.get('iid'), '456');
    assert.equal(u.searchParams.has('ts'), false);
    assert(
      Number(u.searchParams.get('_rticket')) >= 1800000000000 &&
        Number(u.searchParams.get('_rticket')) < 1800000001024
    );
    for (const h of ['Cookie', 'X-Argus', 'X-Gorgon', 'X-Ladon'])
      assert.equal(r.headers[h], undefined);
  }
  assert.throws(() => profile.build('wrong', '1004', device, 1));
  for (const data of [{ video_model: {} }, { 124: { video_model: {} } }])
    assert.deepEqual(profile.normalize({ code: 0, data }, '123', '1004').data, {});
});

// Load the production provider with an isolated transport and expose only its
// existing resolver entry point. Neither identity nor signing is mocked.
function fixture(reply, registrationReply) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-v5-test-'));
  const before = process.env.HONGGUO_WEBOS_CACHE_DIR;
  process.env.HONGGUO_WEBOS_CACHE_DIR = root;
  const requests = [];
  let registrations = 0;
  const transport = {
    request(options) {
      const item = { options, chunks: [], destroyed: false, respond: null };
      requests.push(item);
      const req = new EventEmitter();
      req.write = (b) => item.chunks.push(Buffer.from(b));
      req.destroy = (e) => {
        item.destroyed = true;
        if (e) process.nextTick(() => req.emit('error', e));
      };
      item.respond = () => {
        if (item.destroyed) return;
        let result;
        if (options.path.startsWith('/service/2/device_register/')) {
          registrations++;
          result = registrationReply ? registrationReply(registrations) : null;
          result = result || {
            body: { device_id_str: String(100 + registrations), install_id_str: '456' }
          };
        } else result = reply(options, item, requests);
        if (result.hold) return;
        const res = new PassThrough();
        res.statusCode = result.status || 200;
        res.headers = result.headers || {};
        req.emit('response', res);
        res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      };
      req.end = () => process.nextTick(item.respond);
      return req;
    }
  };
  const file = require.resolve('../webos/service/provider'),
    mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  const normal = mod.require.bind(mod);
  mod.require = (id) =>
    id === 'https'
      ? transport
      : id === './range-media'
        ? {
            open: () =>
              Promise.resolve({
                prefix: Buffer.alloc(16),
                samples: [],
                key: Buffer.alloc(16),
                length: 128,
                etag: '"fixture"'
              }),
            prefetchHead: () => Promise.resolve(0),
            headDiagnostics: () => ({}),
            clearHeadCache: () => {}
          }
        : normal(id);
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split('prepare: prepare,').length, 2);
  mod._compile(
    source.replace('prepare: prepare,', '_videoOptions: videoOptions, prepare: prepare,'),
    file
  );
  const provider = mod.exports;
  return {
    provider,
    requests,
    get registrations() {
      return registrations;
    },
    resolve(vid = '123', signal, state = {}) {
      return provider._videoOptions(vid, signal, { identityState: state, contentType: '1004' });
    },
    close() {
      provider.closeCache();
      if (before === undefined) delete process.env.HONGGUO_WEBOS_CACHE_DIR;
      else process.env.HONGGUO_WEBOS_CACHE_DIR = before;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
function spade() {
  const decoded = Buffer.from('0' + '29'.repeat(16)),
    raw = Buffer.alloc(38),
    previous = [250, 85];
  for (let i = 0; i < decoded.length; i++) {
    const bits = i.toString(2).replace(/0/g, '').length;
    raw[i + 1] = ((decoded[i] + 21 + bits) & 255) ^ previous[i % 2];
    previous[i % 2] = raw[i + 1];
  }
  raw[0] = 52 ^ raw[1] ^ raw[2];
  const seed = raw[32] ^ raw[33];
  Buffer.from('test').forEach((v, i) => (raw[34 + i] = v ^ seed));
  return raw.toString('base64');
}
function model(codec = 'h265') {
  return {
    video_id: '123',
    video_duration: 90,
    video_list: [
      {
        main_url: 'https://media.example.test/video.mp4',
        video_meta: { vwidth: 1920, vheight: 1080, definition: '1080P', codec_type: codec },
        encrypt_info: { spade_a: spade() }
      }
    ]
  };
}
function response(options, codec = 'h265') {
  const query = new URL('https://fixture.test' + options.path).searchParams;
  const id = options.path.includes('/video_tab/')
    ? query.get('video_id')
    : query.get('fixture_vid') || '123';
  const entries = { [id]: { video_model: model(codec) } };
  return {
    body: {
      code: 0,
      data: options.path.includes('/video_tab/') ? { video_model_data: entries } : entries
    }
  };
}
const isV5 = (o) => o.path.startsWith('/novel/player/multi_video_model/player/v1');
const isOld = (o) => o.path.startsWith('/novel/player/multi_video_model/v1/');
const noTab = (o) => (o.path.includes('/video_tab/') ? { body: { code: 0, data: {} } } : null);

test('healthy video_tab stays the fast path without v5 registration', async () => {
  const f = fixture((o) => response(o));
  try {
    assert.equal((await f.resolve()).length, 1);
    assert.equal(f.registrations, 1);
    assert.equal(
      f.requests.some((x) => isV5(x.options)),
      false
    );
  } finally {
    f.close();
  }
});
test('v5 reuses independent identity across episodes; media failure retains old multi within its budget', async () => {
  const f = fixture((o) => noTab(o) || response(o));
  try {
    const state = {};
    assert.equal((await f.resolve('123', null, state))[0].height, 1080);
    assert.equal(state.multiLegacyPending, true);
    assert.equal(f.registrations, 2);
    await f.resolve('123', null, state);
    assert.equal(state.multiLegacyPending, false);
    assert(f.requests.some((x) => isOld(x.options)));
    assert(state.resolveSpent < 30000);
    assert(state.primarySpent < 22000);
    await f.resolve();
    assert.equal(f.registrations, 3); // Only old multi registered anew.
    const v5 = f.requests.filter((x) => isV5(x.options));
    assert.equal(v5.length, 2);
    assert.equal(
      new URL('https://fixture.test' + v5[0].options.path).searchParams.get('device_id'),
      new URL('https://fixture.test' + v5[1].options.path).searchParams.get('device_id')
    );
  } finally {
    f.close();
  }
});
test('v7.7 mobile V5 uses the alternate host with the same registered identity', async () => {
  const seen = [];
  const f = fixture((o) => {
    if (isV5(o)) {
      const u = new URL('https://fixture.test' + o.path);
      seen.push({ host: o.hostname, device: u.searchParams.get('device_id'), version: u.searchParams.get('version_name') });
      if (o.hostname.indexOf('sinfonlineb') >= 0) return { body: '' };
      return response(o);
    }
    return noTab(o) || response(o);
  });
  try {
    assert.equal((await f.resolve()).length, 1);
    assert.deepEqual(seen.map((x) => x.host), ['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-sinfonlinea.fqnovel.com']);
    assert.equal(seen[0].device, seen[1].device);
    assert.deepEqual(seen.map((x) => x.version), ['7.4.3.32', '7.4.3.32']);
    assert.equal(f.registrations, 2); // initial video_tab plus one mobile V5 identity
  } finally {
    f.close();
  }
});
test('v7.7 same-identity video_tab recovery follows two empty V5 hosts', async () => {
  const seen = [];
  const f = fixture((o) => {
    if (isV5(o)) {
      const u = new URL('https://fixture.test' + o.path);
      seen.push({ host: o.hostname, device: u.searchParams.get('device_id'), version: u.searchParams.get('version_name') });
      return { body: '' };
    }
    if (o.path.includes('/video_tab/')) {
      const u = new URL('https://fixture.test' + o.path);
      // The initial provider is intentionally unavailable. The recovery GET
      // is recognized by the v7.7 7.4.3.32 query profile.
      if (u.searchParams.get('version_name') === '7.4.3.32') return response(o);
      return noTab(o);
    }
    return response(o);
  });
  try {
    assert.equal((await f.resolve()).length, 1);
    assert.deepEqual(seen.map((x) => x.host), ['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-sinfonlinea.fqnovel.com']);
    assert.equal(seen[0].device, seen[1].device);
    const recovery = f.requests.find((x) => x.options.path.includes('/video_tab/') && new URL('https://fixture.test' + x.options.path).searchParams.get('version_name') === '7.4.3.32');
    assert(recovery);
    assert.equal(new URL('https://fixture.test' + recovery.options.path).searchParams.get('device_id'), seen[0].device);
    assert.equal(recovery.options.headers['X-SS-STUB'], undefined);
    assert.equal(recovery.options.headers['Content-Type'], undefined);
    assert.equal(f.registrations, 2);
  } finally {
    f.close();
  }
});
test('Retry-After on either V5 host skips further same-identity recovery', async () => {
  for (const backoffHost of ['sinfonlineb', 'sinfonlinea']) {
    const f = fixture((o) => {
      if (isV5(o)) return { body: '', headers: o.hostname.includes(backoffHost) ? { 'retry-after': '30' } : {} };
      return noTab(o) || response(o);
    });
    try {
      assert.equal((await f.resolve()).length, 1);
      assert.equal(f.requests.filter((x) => isV5(x.options)).length, backoffHost === 'sinfonlineb' ? 1 : 2);
      assert.equal(f.requests.filter((x) => x.options.path.includes('/video_tab/') && x.options.headers['X-Medusa']).length, 0);
    } finally {
      f.close();
    }
  }
});

test('a failed recovery GET retains the original empty diagnostic and reaches the old provider', async () => {
  const f = fixture((o) => {
    if (isV5(o)) return { body: '' };
    if (o.path.includes('/video_tab/')) return { status: 404, body: '' };
    return response(o);
  });
  try {
    assert.equal((await f.resolve()).length, 1);
    assert.equal(f.requests.filter((x) => isV5(x.options)).length, 2);
    assert.equal(f.requests.filter((x) => x.options.path.includes('/video_tab/') && x.options.headers['X-Medusa']).length, 1);
    assert.equal(f.requests.filter((x) => isOld(x.options)).length, 1);
    assert.equal(f.registrations, 3);
  } finally {
    f.close();
  }
});

test('v7.7 recovery query keeps the reference profile, ordered signature and bodyless headers', () => {
  const request = profile.videoTabRecovery('123', device, 1800000000000);
  const url = new URL(request.url);
  assert.deepEqual([...url.searchParams.keys()], [
    'aid', 'app_name', 'version_code', 'version_name', 'manifest_version_code', 'channel', 'device_platform',
    'device_type', 'os_version', 'update_version_code', 'iid', 'cdid', 'device_id',
    'video_id', 'video_id_type', 'device_level', 'need_all_video_definition',
    'need_mp4_align', 'use_os_player', 'video_platform', 'source', 'from_video_id', '_rticket'
  ]);
  assert.equal(url.searchParams.get('version_code'), '74332');
  assert.equal(url.searchParams.get('update_version_code'), '74332');
  assert.equal(url.searchParams.get('version_name'), '7.4.3.32');
  assert.equal(url.searchParams.get('device_type'), 'PGT-AN10');
  assert.equal(url.searchParams.get('os_version'), '12');
  assert.equal(url.searchParams.get('channel'), 'vivo_8662_64');
  assert.equal(passport.branch(url.search.slice(1), Buffer.alloc(0), 1800000000).iv & 15, 12);
  assert.equal(request.headers['X-SS-STUB'], undefined);
  assert.equal(request.headers['Content-Type'], undefined);
  assert.match(request.headers['User-Agent'], /^com\.phoenix\.read\/73932 /);
});
test('v5 all-ByteVC2 follows unchanged codec fallback to same-episode HEVC', async () => {
  const codecs = [];
  const f = fixture((o) => {
    if (noTab(o)) return noTab(o);
    if (o.path.startsWith('/playback/fallback')) {
      const c = new URL('https://fixture.test' + o.path).searchParams.get('codec_type');
      codecs.push(c);
      assert.equal(o.headers['X-Medusa'], undefined);
      assert.equal(o.headers.Cookie, undefined);
      return {
        body: { code: 0, video_info: { code: 0, data: model(c === '1' ? 'h265' : 'bytevc2') } }
      };
    }
    const r = response(o, 'bytevc2');
    r.body.data['123'].video_model.fallback_api =
      'https://api.fqnovel.com/playback/fallback?sig=a%2fb&codec_type=4';
    return r;
  });
  try {
    assert.equal((await f.resolve())[0].height, 1080);
    assert.deepEqual(codecs, ['4', '1']);
    assert.equal(
      f.requests.some((x) => isOld(x.options)),
      false
    );
  } finally {
    f.close();
  }
});
test('empty 200 tries alternate V5 and same-identity video_tab before old multi', async () => {
  for (const mode of ['empty', 'wrong', 'invalid', 'http', 'large']) {
    let calls = 0;
    const f = fixture((o) => {
      if (noTab(o)) return noTab(o);
      if (!isV5(o)) return response(o);
      calls++;
      if (mode === 'empty') return { body: '' };
      if (mode === 'wrong') return { body: { code: 0, data: { 124: { video_model: model() } } } };
      if (mode === 'invalid') return { body: '{}{}' };
      if (mode === 'large') return { body: ' '.repeat(profile.maxJSON + 1) };
      return { status: 503, body: '' };
    });
    try {
      assert.equal((await f.resolve()).length, 1);
      assert.equal(calls, mode === 'empty' ? 2 : 1);
      assert.equal(f.registrations, 3);
    } finally {
      f.close();
    }
  }
});
test('business rejection stops without old fallback or identity churn', async () => {
  const f = fixture((o) => noTab(o) || { body: { code: 12345 } });
  try {
    await assert.rejects(f.resolve());
    assert.equal(f.registrations, 2);
    assert.equal(
      f.requests.some((x) => isOld(x.options)),
      false
    );
  } finally {
    f.close();
  }
});
test('cancellation and shutdown abort pending v5 transport; service wake rebuilds identity', async () => {
  for (const shutdown of [false, true]) {
    let hold = true;
    const f = fixture((o) => noTab(o) || (hold ? { hold: true } : response(o))),
      c = cancel.create();
    try {
      const observed = (
        shutdown
          ? f.provider.prepare('123', '123', '1080P', true, 'range', false, c.signal)
          : f.resolve('123', c.signal)
      ).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      for (let i = 0; i < 100 && !f.requests.some((x) => isV5(x.options)); i++) await tick();
      const pending = f.requests.find((x) => isV5(x.options));
      assert(pending);
      if (shutdown) f.provider.closeCache();
      else c.abort();
      assert.equal((await observed).error.name, 'AbortError');
      assert.equal(pending.destroyed, true);
      pending.respond();
      assert.equal(
        f.requests.some((x) => isOld(x.options)),
        false
      );
      if (shutdown) {
        hold = false;
        f.provider.startCache();
        assert.equal(
          (await f.provider.prepare('123', '123', '1080P', true, 'range', false)).mode,
          'range'
        );
        assert.equal(f.registrations, 4);
      }
    } finally {
      f.close();
    }
  }
});
