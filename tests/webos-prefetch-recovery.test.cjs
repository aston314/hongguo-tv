'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const cancel = require('../webos/service/audio-cancel');
const tick = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const providerFile = process.env.HONGGUO_WEBOS_PROVIDER_UNDER_TEST || require.resolve('../webos/service/provider');

function spade() {
  const decoded = Buffer.from('0' + '29'.repeat(16)), raw = Buffer.alloc(38), previous = [250, 85];
  for (let i = 0; i < decoded.length; i++) {
    const bits = i.toString(2).replace(/0/g, '').length;
    raw[i + 1] = ((decoded[i] + 21 + bits) & 255) ^ previous[i % 2];
    previous[i % 2] = raw[i + 1];
  }
  raw[0] = 52 ^ raw[1] ^ raw[2];
  const seed = raw[32] ^ raw[33];
  Buffer.from('test').forEach((value, i) => { raw[34 + i] = value ^ seed; });
  return raw.toString('base64');
}
function observe(promise) { return promise.then(value => ({ value }), error => ({ error })); }
async function until(predicate) {
  for (let i = 0; i < 600; i++) { if (predicate()) return; await pause(5); }
  throw Error('Expected preparation event did not occur');
}
function fixture(replies, warmHead, registrationReplies = [], tabReply = { code: 100103 }) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-prefetch-recovery-'));
  const before = process.env.HONGGUO_WEBOS_CACHE_DIR;
  process.env.HONGGUO_WEBOS_CACHE_DIR = cache;
  const requests = [], registrationRequests = [], tabRequests = [];
  let registrations = 0;
  let rangeOpens = 0, downloads = 0, headWarms = 0;
  const transport = { request(options) {
    const req = new EventEmitter();
    if (options.path.startsWith('/service/2/device_register/')) {
      registrations++;
      const index = registrations, reply = registrationReplies[index - 1] || {};
      const registration = {destroyed:false, respond:null}; registrationRequests.push(registration);
      req.write = () => {};
      req.destroy = error => { registration.destroyed = true; if (error) process.nextTick(() => req.emit('error', error)); };
      registration.respond = () => {
        if (registration.destroyed) return;
        if (reply.network) { const error = new Error('private registration endpoint'); error.code = reply.network; req.emit('error', error); return; }
        const res = new PassThrough(); res.statusCode = reply.status || 200; res.headers = {};
        req.emit('response', res);
        res.end(JSON.stringify({ device_id_str: '123456789012345678' + index, install_id_str: '223456789012345678' + index }));
      };
      req.end = () => { if (!reply.hold) process.nextTick(registration.respond); };
      return req;
    }
    if (options.path.startsWith('/reading/bookapi/video_tab/multi_video_model/v1/')) {
      tabRequests.push(options);
      req.write = () => {}; req.destroy = () => {};
      req.end = () => process.nextTick(() => {
        const res = new PassThrough(); res.statusCode = 200; res.headers = {};
        req.emit('response', res); res.end(JSON.stringify(tabReply));
      });
      return req;
    }
    assert(options.path.startsWith('/novel/player/multi_video_model/v1/'));
    const index = requests.length, reply = replies[index] || {};
    const item = { options, destroyed: false, body: [], respond: null, at: Date.now(), device: new URL('https://fixture.test'+options.path).searchParams.get('device_id') };
    requests.push(item);
    req.write = data => item.body.push(Buffer.from(data));
    req.destroy = error => { item.destroyed = true; if (error) process.nextTick(() => req.emit('error', error)); };
    item.respond = () => {
      if (item.destroyed) return;
      if (reply.network) { const error = new Error(reply.network); error.code = reply.network; req.emit('error', error); return; }
      const res = new PassThrough(); res.statusCode = reply.status || 200; res.headers = {};
      req.emit('response', res);
      const vid = JSON.parse(Buffer.concat(item.body)).mixed_video_id_map['1004'][0];
      res.end(reply.empty ? '' : reply.body !== undefined ? reply.body : JSON.stringify({ data: { [vid]: { video_model: { video_list: [{
        main_url: 'https://media.example.test/recovery.mp4', video_meta: { vheight: 720, definition: '720P' }, encrypt_info: { spade_a: spade() }
      }] } } } }));
    };
    req.end = () => { if (!reply.hold) process.nextTick(item.respond); };
    return req;
  } };
  const mod = new Module(providerFile, module); mod.filename = providerFile; mod.paths = Module._nodeModulePaths(path.dirname(providerFile));
  const normal = mod.require.bind(mod);
  mod.require = id => id === 'https' ? transport : id === './range-media' ? {
    open() { rangeOpens++; return Promise.resolve({ prefix: Buffer.alloc(16), samples: [], key: Buffer.alloc(16), length: 128, etag: '"fixture"' }); },
    prefetchHead(source, signal) { headWarms++; return warmHead ? warmHead(source, signal) : Promise.resolve(0); },
    headDiagnostics() { return { media_head_cache_bytes: 128, media_head_cache_hits: 0 }; },
    downloadFile() { downloads++; throw Error('Recovery must not download a complete video'); }
  } : normal(id);
  mod._compile(fs.readFileSync(providerFile, 'utf8'), providerFile);
  const provider = mod.exports, consumers = [], prepare = provider.prepare;
  provider.prepare = function (...args) {
    consumers.push({ prefetch: args[5], signal: args[6] }); return prepare.apply(provider, args);
  };
  return { provider, requests, registrationRequests, tabRequests, consumers, get registrations() { return registrations; }, get rangeOpens() { return rangeOpens; }, get downloads() { return downloads; },
    get headWarms() { return headWarms; },
    prepare(prefetch, signal) { return provider.prepare('123', '456', '', true, 'range', prefetch, signal); },
    close() { provider.closeCache(); if (before === undefined) delete process.env.HONGGUO_WEBOS_CACHE_DIR; else process.env.HONGGUO_WEBOS_CACHE_DIR = before; fs.rmSync(cache, { recursive: true }); }
  };
}

test('registration transport diagnostics identify the actual phase without changing recovery budgets', async () => {
  const recovery = require('../core/cmd/hongguotv/ui/playback-recovery');
  const f = fixture([], null, [{network:'ENOTFOUND'}, {network:'ENOTFOUND'}]);
  try {
    const result = await observe(f.prepare(false));
    assert.equal(result.error.videoModel.stage, 'device_register');
    assert.equal(result.error.videoModel.network_reason, 'dns');
    const safe = recovery.preparationFailure(result.error);
    assert.equal(safe.stage, 'device_register'); assert.equal(safe.network_reason, 'dns');
    assert.equal(safe.http_status, undefined);
    assert.equal(f.registrations, 2); assert.equal(f.requests.length, 0); assert.equal(f.tabRequests.length, 0);
    assert.doesNotMatch(JSON.stringify(safe), /private|endpoint/);
  } finally { f.close(); }
});

test('source preparation is available to foreground while network-only head warming is still pending', async () => {
  let finish;
  const f = fixture([{}], () => new Promise(resolve => { finish = resolve; }));
  try {
    const speculative = f.prepare(true); await until(() => f.headWarms === 1);
    const current = await f.prepare(false);
    assert.equal(current.mode, 'range'); assert.equal(current.preparation_cached, true);
    assert.equal(f.requests.length, 1); assert.equal(f.registrations, 2); assert.equal(f.rangeOpens, 1);
    finish(128); assert.equal((await speculative).path, current.path);
    assert.equal(f.downloads, 0);
  } finally { f.close(); }
});

test('failed speculative head data keeps valid play info and never starts a full-file fallback', async () => {
  const f = fixture([{}], () => Promise.reject(new Error('head unavailable')));
  try {
    const speculative = await f.prepare(true), foreground = await f.prepare(false);
    assert.equal(speculative.preparation_timing.media_head_prefetch_failed, true);
    assert.equal(speculative.path, foreground.path);
    assert.equal(f.requests.length, 1); assert.equal(f.downloads, 0);
  } finally { f.close(); }
});

test('a foreground handoff recovers a failed speculative source once, without full download', async () => {
  const f = fixture([{ status: 502, hold: true }, {}]);
  try {
    const background = observe(f.prepare(true)); await tick();
    const foreground = observe(f.prepare(false)); f.requests[0].respond();
    const result = await foreground;
    assert(!result.error, 'foreground must get a new source attempt after its shared prefetch fails');
    assert.equal(result.value.mode, 'range'); assert.equal(result.value.preparation_shared, true);
    assert.equal(f.requests.length, 2); assert.equal(f.rangeOpens, 1); assert.equal(f.downloads, 0);
    assert.equal(result.value.preparation_timing.media_resolve_retries, 1);
    assert.equal((await background).value.path, result.value.path);
    assert.equal(f.provider.foregroundVideoModelDiagnostics().code, 'VIDEO_MODEL_OK');
    assert.equal(f.provider.foregroundVideoModelDiagnostics().attempt, 2, 'an adopted prefetch is the current foreground diagnostic');
  } finally { f.close(); }
});

test('successful sharing still resolves only once', async () => {
  const f = fixture([{ hold: true }]);
  try { const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false)); f.requests[0].respond();
    const [x, y] = await Promise.all([b, p]); assert(!x.error && !y.error); assert.equal(x.value.path, y.value.path);
    assert.equal(f.requests.length, 1); assert.equal(f.rangeOpens, 1);
  } finally { f.close(); }
});

test('speculative errors stay single-shot while direct foreground errors keep the four-request budget', async () => {
  const speculative = fixture([{ status: 502 }]);
  try {
    const result = await observe(speculative.prepare(true));
    assert.equal(result.error.code, 'VIDEO_MODEL_HTTP');
    await pause(300);
    assert.equal(speculative.requests.length, 1, 'speculative preparation must not self-retry');
  } finally { speculative.close(); }

  const recovered = fixture([{ status: 502 }, {}]);
  try {
    const result = await observe(recovered.prepare(false));
    assert(!result.error, 'a direct foreground transient error should recover once');
    assert.equal(recovered.requests.length, 2); assert.equal(recovered.registrations, 2);
    assert.equal(result.value.preparation_timing.media_resolve_retries, 1);
  } finally { recovered.close(); }

  const exhausted = fixture([{ status: 502 }, { status: 503 }, { status: 504 }, { status: 502 }, {}]);
  try {
    const result = await observe(exhausted.prepare(false));
    assert.equal(result.error.code, 'VIDEO_MODEL_HTTP');
    assert.equal(exhausted.requests.length, 4, 'foreground retry budget is bounded to two identities and two hosts');
  } finally { exhausted.close(); }
});

test('concurrent foreground consumers share the one recovery, including a late join', async () => {
  const f = fixture([{ status: 503, hold: true }, { hold: true }]);
  try {
    const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false)), q = observe(f.prepare(false));
    f.requests[0].respond(); await until(() => f.requests.length === 2);
    const late = observe(f.prepare(false)); f.requests[1].respond();
    const results = await Promise.all([b, p, q, late]);
    assert(results.every(x => !x.error)); assert.equal(new Set(results.map(x => x.value.path)).size, 1);
    assert.equal(f.requests.length, 2); assert.equal(f.rangeOpens, 1);
  } finally { f.close(); }
});

test('an exhausted lookup fails normally and an explicit retry gets a fresh identity', async () => {
  const f = fixture([{ status: 502, hold: true }, { status: 503 }, { status: 502 }, { status: 503 }, {}]);
  try { const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false)); f.requests[0].respond();
    assert.equal((await p).error.status, 503); assert((await b).error); assert.equal(f.requests.length, 4);
    assert.equal((await f.prepare(false)).mode, 'range'); assert.equal(f.requests.length, 5);
  } finally { f.close(); }
});

test('permission, missing source, malformed response and unsupported quality errors are not retried', async () => {
  for (const reply of [{ status: 401 }, { status: 403 }, { status: 404 }, { body: 'invalid JSON' }, { body: '{}' },
    { body: JSON.stringify({ data: { video_model: { video_list: [] } } }) }]) {
    const f = fixture([Object.assign({ hold: true }, reply)]);
    try { const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false)); f.requests[0].respond();
      assert((await p).error); assert((await b).error); assert.equal(f.requests.length, 1); assert.equal(f.downloads, 0);
    } finally { f.close(); }
  }
  const f = fixture([{ hold: true }]);
  try {
    const b = observe(f.provider.prepare('123', '456', '1080P', false, 'range', true)); await tick();
    const p = observe(f.provider.prepare('123', '456', '1080P', false, 'range', false)); f.requests[0].respond();
    assert.match((await p).error.message, /本集不提供/); assert((await b).error); assert.equal(f.requests.length, 1);
  } finally { f.close(); }
});

test('temporary transport errors and empty responses recover within the shared budget', async () => {
  for (const replies of [[{ hold: true, network: 'ECONNRESET' }, {}], [{ hold: true, empty: true }, { empty: true }, {}]]) {
    const f = fixture(replies);
    try { const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false)); f.requests[0].respond();
      assert(!(await p).error); await b; assert.equal(f.requests.length, replies.length); assert.equal(f.rangeOpens, 1);
    } finally { f.close(); }
  }
});

test('shared empty responses use one replacement and stop at four requests with current-job diagnostics', async () => {
  const f = fixture([{ hold: true, empty: true }, ...Array.from({ length: 3 }, () => ({ empty: true }))]);
  try {
    const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false)); f.requests[0].respond();
    const { error } = await p;
    assert.equal(error.code, 'VIDEO_MODEL_EMPTY'); await b; assert.equal(f.requests.length, 4); assert.equal(f.registrations,3); assert.equal(f.rangeOpens, 0);
    assert.equal(error.recoveryComplete, true);
    assert.equal(error.upstreamStatus, 200, 'HTTP 200 upstream is distinct from the local 502 failure response');
    assert.equal(error.videoModel.attempt, 4);
    assert.equal(error.videoModel.http_status, 200);
    assert.equal(error.videoModel.response_bytes, 0);
    assert.equal(error.videoModel.stage, 'multi_video_model');
    assert(f.requests[1].at - f.requests[0].at >= 230);
    assert(f.requests[2].at - f.requests[1].at >= 980);
    const report = f.provider.mediaDiagnostics('');
    assert.equal(report.media_preparation_error_stage, 'multi_video_model');
    assert.equal(report.media_preparation_error_code, 'VIDEO_MODEL_EMPTY');
    assert.equal(report.media_video_model.attempt, 4);
    assert(!/video_id|media\.example|cookie|token/i.test(JSON.stringify(error.videoModel)));
  } finally { f.close(); }
});

test('direct empty responses back off twice, while speculative empty responses stay single-shot', async () => {
  const f = fixture([{ empty: true }, { empty: true }, {}]);
  try {
    const current = await f.prepare(false);
    assert.equal(f.requests.length, 3); assert.equal(f.registrations, 3);
    assert(f.requests[1].at - f.requests[0].at >= 230);
    assert(f.requests[2].at - f.requests[1].at >= 980);
    assert.equal(current.preparation_timing.media_video_model.code, 'VIDEO_MODEL_OK');
    assert.equal(current.preparation_timing.media_video_model.attempt, 3);
    assert.equal(current.preparation_timing.media_preparation_error_code, undefined);
    assert.equal(f.downloads, 0);
  } finally { f.close(); }
  const speculative = fixture([{ empty: true }, {}]);
  try {
    const { error } = await observe(speculative.prepare(true));
    assert.equal(error.code, 'VIDEO_MODEL_EMPTY');
    assert.equal(speculative.requests.length, 1);
    assert.equal(speculative.registrations, 2);
  } finally { speculative.close(); }
});

test('mixed empty and HTTP failures share the same four-request maximum', async () => {
  const f = fixture([{ empty: true }, { status: 502 }, { empty: true }, { empty: true }, {}]);
  try {
    const { error } = await observe(f.prepare(false));
    assert.equal(error.code, 'VIDEO_MODEL_EMPTY'); assert.equal(error.recoveryComplete, true);
    assert.equal(f.requests.length, 4); assert.equal(error.videoModel.attempt, 4);
    assert.equal(f.registrations, 3, 'mixed failures still use only two fresh legacy identities');
    assert.equal(f.rangeOpens, 0); assert.equal(f.downloads, 0);
  } finally { f.close(); }
});

test('cancelling direct empty-response backoff stops work; cancelling prefetch preserves its foreground waiter', async () => {
  const f = fixture([{ empty: true }, {}]), a = cancel.create();
  try {
    const pending = observe(f.prepare(false, a.signal)); await tick(); a.abort();
    assert.equal((await pending).error.name, 'AbortError'); await pause(300);
    assert.equal(f.requests.length, 1);
  } finally { f.close(); }
  const shared = fixture([{ hold: true }, {}]), b = cancel.create();
  try {
    const speculative = observe(shared.prepare(true, b.signal)); await tick();
    const current = observe(shared.prepare(false)); b.abort(); shared.requests[0].respond();
    assert.equal((await speculative).error.name, 'AbortError');
    assert(!(await current).error); assert.equal(shared.requests.length, 1);
  } finally { shared.close(); }
});

test('a speculative waiter cannot continue foreground retries after its last foreground user leaves', async () => {
  const f=fixture([{hold:true,empty:true},{}]),c=cancel.create();
  try {
    const current=observe(f.prepare(false,c.signal));await tick();
    const prefetch=observe(f.prepare(true));c.abort();f.requests[0].respond();
    assert.equal((await current).error.name,'AbortError');
    assert.equal((await prefetch).error.code,'VIDEO_MODEL_EMPTY');
    await pause(300);assert.equal(f.requests.length,1);
  } finally { f.close(); }
});

test('leaving during direct backoff does not issue a delayed request for a remaining prefetch waiter', async () => {
  const f=fixture([{hold:true,empty:true},{}]),c=cancel.create();
  try {
    const current=observe(f.prepare(false,c.signal));await tick();
    const prefetch=observe(f.prepare(true));f.requests[0].respond();await tick();c.abort();
    assert.equal((await current).error.name,'AbortError');
    assert.equal((await prefetch).error.code,'VIDEO_MODEL_EMPTY');
    assert.equal(f.requests.length,1);
  } finally { f.close(); }
});

test('a later prefetch success never overwrites the foreground empty-response diagnostic', async () => {
  const f = fixture([...Array.from({length:4},()=>({empty:true})),{}]);
  try {
    const { error } = await observe(f.prepare(false));
    await f.provider.prepare('123', '789', '', true, 'range', true);
    assert.equal(f.provider.videoModelDiagnostics().code, 'VIDEO_MODEL_OK');
    assert.equal(error.videoModel.code, 'VIDEO_MODEL_EMPTY');
    assert.equal(f.provider.mediaDiagnostics('').media_video_model.code, 'VIDEO_MODEL_EMPTY');
    assert.equal(f.provider.mediaDiagnostics('').media_preparation_error_code, 'VIDEO_MODEL_EMPTY');
    assert.equal(f.provider.foregroundVideoModelDiagnostics().code, 'VIDEO_MODEL_EMPTY');
  } finally { f.close(); }
});

test('a late older foreground result cannot overwrite the newest foreground failure', async () => {
  const f=fixture([{hold:true},...Array.from({length:4},()=>({empty:true}))]);
  try {
    const old=observe(f.prepare(false));await tick();
    const current=await observe(f.provider.prepare('123','789','',true,'range',false));
    assert.equal(current.error.code,'VIDEO_MODEL_EMPTY');
    f.requests[0].respond();assert(!(await old).error);
    assert.equal(f.provider.foregroundVideoModelDiagnostics().code,'VIDEO_MODEL_EMPTY');
    assert.equal(f.provider.foregroundVideoModelDiagnostics().attempt,4);
    assert.equal(f.provider.mediaDiagnostics('').media_preparation_error_code,'VIDEO_MODEL_EMPTY');
  } finally { f.close(); }
});

test('cancelling the only foreground waiter before failure prevents recovery', async () => {
  const f = fixture([{ status: 502, hold: true }]), c = cancel.create();
  try { const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false, c.signal)); c.abort();
    assert.equal((await p).error.name, 'AbortError'); f.requests[0].respond(); assert((await b).error);
    await pause(300); assert.equal(f.requests.length, 1);
  } finally { f.close(); }
});

test('cancelling during recovery backoff prevents a new upstream request', async () => {
  const f = fixture([{ status: 502, hold: true }]), c = cancel.create();
  try { const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false, c.signal)); f.requests[0].respond();
    await tick(); c.abort(); assert.equal((await p).error.name, 'AbortError'); await b;
    await pause(300); assert.equal(f.requests.length, 1);
  } finally { f.close(); }
});

test('cancelling one consumer keeps the shared recovery alive for the other', async () => {
  const f = fixture([{ status: 502, hold: true }, {}]), a = cancel.create(), c = cancel.create();
  try { const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false, a.signal)), q = observe(f.prepare(false, c.signal));
    a.abort(); f.requests[0].respond(); assert.equal((await p).error.name, 'AbortError'); assert(!(await q).error); await b;
    assert.equal(f.requests.length, 2);
  } finally { f.close(); }
});

test('cancelling the last foreground consumer aborts an in-flight recovery', async () => {
  const f = fixture([{ status: 502, hold: true }, { hold: true }]), c = cancel.create();
  try { const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false, c.signal)); f.requests[0].respond();
    await until(() => f.requests.length === 2); c.abort(); assert.equal((await p).error.name, 'AbortError'); await b;
    assert.equal(f.requests[1].destroyed, true); assert.equal(f.rangeOpens, 0); assert.equal(f.requests.length, 2);
  } finally { f.close(); }
});

test('a new foreground request never joins a cancelled recovery still settling', async () => {
  const f = fixture([{ status: 502, hold: true }, {}]), c = cancel.create();
  try {
    const b = observe(f.prepare(true)); await tick(); const p = observe(f.prepare(false, c.signal)); f.requests[0].respond();
    await tick(); c.abort();
    // Call synchronously before the cancelled job's rejection handlers run.
    const fresh = observe(f.prepare(false));
    assert.equal((await p).error.name, 'AbortError'); assert(!(await fresh).error); await b;
    assert.equal(f.requests.length, 2); assert.equal(f.rangeOpens, 1);
  } finally { f.close(); }
});

async function service(f) {
  const create = require(path.join(path.dirname(providerFile), 'service'));
  const s = create({ service: { register() {} }, provider: f.provider, account: {}, numberInput: { close() {} }, updates: {}, port: 0 });
  await s.ensureReady(); return s;
}
function request(s, prefetch) {
  let req;
  const promise = new Promise((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port: s.address().port, path: '/api/v1/play/info?series_id=123&vid=456&fallback=1&mode=range' + (prefetch ? '&prefetch=1' : '') }, res => {
      let text = ''; res.on('data', x => { text += x; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    }); req.on('error', reject);
  });
  return { promise, abort() { req.destroy(); } };
}

test('HTTP playback failures carry their own sanitized diagnostic after unrelated prefetch completes', async () => {
  const f = fixture([...Array.from({length:4},()=>({empty:true})),{}]);
  const prepare = f.provider.prepare;
  f.provider.prepare = (...args) => prepare(...args).catch(async error => {
    await prepare('123', '789', '', true, 'range', true); throw error;
  });
  const s = await service(f);
  try {
    const result = await request(s, false).promise;
    assert.equal(result.status, 502); assert.equal(result.data.upstream_status, 200);
    assert.equal(result.data.error, 'VIDEO_MODEL_EMPTY'); assert.equal(result.data.recovery_complete, true);
    assert.equal(result.data.video_model.code, 'VIDEO_MODEL_EMPTY');
    assert.equal(result.data.video_model.response_bytes, 0); assert.equal(result.data.video_model.attempt, 4);
    assert.equal(result.data.stage, 'multi_video_model');
    assert.equal(result.data.video_model.video_id, undefined);
  } finally { await s.shutdown(); f.close(); }
});

test('a transport failure with no HTTP response does not invent an upstream HTTP 502', async () => {
  const f=fixture(Array.from({length:4},()=>({network:'ECONNRESET'}))),s=await service(f);
  try {
    const result=await request(s,false).promise;
    assert.equal(result.status,502);assert.equal(result.data.error,'ECONNRESET');
    assert.equal(result.data.upstream_status,undefined);assert.equal(result.data.video_model.http_status,undefined);
    assert.equal(result.data.video_model.stage,'multi_video_model_transport');
    assert.equal(result.data.video_model.attempt,4);assert.equal(result.data.recovery_complete,true);
  } finally { await s.shutdown();f.close(); }
});

test('actual HTTP handoff and the page 1200ms deadline recover without a retry-button click', async () => {
  const f = fixture([{ status: 502, hold: true }, {}]), s = await service(f);
  try {
    const b = request(s, true); await until(() => f.requests.length === 1);
    const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
    const begin = source.indexOf('  function waitForPlaybackPrefetch('), end = source.indexOf('\n  function recoverPlaybackAfterError(', begin);
    assert(begin >= 0 && end > begin);
    const context = { Promise, setTimeout, clearTimeout, feedGeneration: 1, playbackDebug() {} };
    vm.runInNewContext(source.slice(begin, end), context);
    const handoff = { promise: b.promise.then(x => x.data.ok ? x.data.data : null) };
    assert.equal(await context.waitForPlaybackPrefetch(handoff, 1, { aborted: false }), null);
    const p = request(s, false); await until(() => f.consumers.some(x => !x.prefetch)); f.requests[0].respond();
    const result = await p.promise;
    assert.equal(result.status, 200); assert.equal(result.data.data.mode, 'range'); await b.promise;
    assert.equal(f.requests.length, 2); assert.equal(f.downloads, 0);
  } finally { await s.shutdown(); f.close(); }
});

test('disconnecting the actual foreground HTTP client prevents a speculative failure from restarting work', async () => {
  const f = fixture([{ status: 502, hold: true }]), s = await service(f);
  try {
    const b = request(s, true); await until(() => f.requests.length === 1);
    const p = request(s, false), ended = observe(p.promise); await until(() => f.consumers.some(x => !x.prefetch));
    p.abort(); await ended; await until(() => f.consumers.some(x => !x.prefetch && x.signal && x.signal.aborted));
    f.requests[0].respond(); await b.promise; await pause(300); assert.equal(f.requests.length, 1);
  } finally { await s.shutdown(); f.close(); }
});

test('new rounds and subsequent episodes use fresh legacy identities while video_tab keeps its identity', async () => {
  const f=fixture([{empty:true},{empty:true},{empty:true},{},{}]);
  try {
    const value=await f.prepare(false);
    assert.equal(f.requests.length,4);assert.equal(f.registrations,3);assert.equal(value.mode,'range');assert.equal(f.downloads,0);
    assert.deepEqual(f.requests.map(r=>r.device),['1234567890123456782','1234567890123456782','1234567890123456783','1234567890123456783']);
    assert.deepEqual(f.requests.map(r=>r.options.hostname),['api5-normal-sinfonlineb.fqnovel.com','api5-normal-hl.fqnovel.com','api5-normal-sinfonlineb.fqnovel.com','api5-normal-hl.fqnovel.com']);
    assert(f.requests.every(r=>r.options.headers['X-Medusa'] && r.options.headers['X-Argus']));
    assert.equal(value.preparation_timing.media_video_model.attempt,4);
    await f.provider.prepare('123','789','',true,'range',false);
    assert.equal(f.requests[4].device,'1234567890123456784');assert.equal(f.registrations,4);
    assert.equal(f.tabRequests.length,2);
    assert.equal(f.tabRequests[0].path.split('device_id=')[1].split('&')[0],f.tabRequests[1].path.split('device_id=')[1].split('&')[0]);
  } finally {f.close();}
});

test('an adopted prefetch shares its host position, fresh identity and four-request limit with all consumers', async () => {
  const f=fixture([{empty:true,hold:true},{empty:true},{empty:true},{}]);
  try {
    const speculative=observe(f.prepare(true));await tick();const foreground=f.prepare(false),another=f.prepare(false);f.requests[0].respond();
    const [a,b,c]=await Promise.all([speculative,foreground,another]);
    assert.equal(a.value.path,b.path);assert.equal(b.path,c.path);
    assert.equal(f.requests.length,4);assert.equal(f.registrations,3);assert.equal(f.tabRequests.length,1);assert.equal(f.rangeOpens,1);assert.equal(f.downloads,0);
    assert.equal(b.preparation_timing.media_video_model.attempt,4);assert.equal(b.preparation_timing.media_resolve_retries,3);
  } finally {f.close();}
});

test('different episodes never share their single-use legacy registration', async () => {
  const f=fixture([{hold:true},{hold:true}]);
  try {
    const first=observe(f.prepare(false));await until(()=>f.requests.length===1);
    const second=observe(f.provider.prepare('123','789','',true,'range',false));await until(()=>f.requests.length===2);
    assert.notEqual(f.requests[0].device,f.requests[1].device);assert.equal(f.registrations,3);
    f.requests[1].respond();f.requests[0].respond();
    assert(!(await first).error);assert(!(await second).error);
  } finally {f.close();}
});

test('a late failure from an earlier episode cannot replace another episode legacy identity', async () => {
  const f=fixture([{hold:true,empty:true},{},{}]);
  try {
    const first=observe(f.prepare(false));await until(()=>f.requests.length===1);
    const second=await f.provider.prepare('123','789','',true,'range',false);
    assert.equal(second.mode,'range');f.requests[0].respond();assert(!(await first).error);
    assert.equal(f.registrations,3);assert.equal(f.requests[2].device,f.requests[0].device);
    assert.notEqual(f.requests[2].device,f.requests[1].device);
  } finally {f.close();}
});

test('failed legacy registration does not poison video_tab or the next episode registration', async () => {
  const f=fixture([{}],null,[{}, {status:503}, {}]);
  try {
    const first=await observe(f.prepare(false));assert.equal(first.error.code,'ACCOUNT_DEVICE');assert.equal(f.requests.length,0);
    const next=await f.provider.prepare('123','789','',true,'range',false);
    assert.equal(next.mode,'range');assert.equal(f.registrations,3);assert.equal(f.requests.length,1);
    assert.equal(f.requests[0].device,'1234567890123456783');assert.equal(f.tabRequests.length,2);
  } finally {f.close();}
});

test('foreground cancellation during second-round registration aborts that job without affecting other episodes', async () => {
  const f=fixture([{empty:true},{empty:true},{}],null,[{}, {}, {hold:true}, {}]),c=cancel.create();
  try {
    const foreground=observe(f.prepare(false,c.signal));await tick();const speculative=observe(f.prepare(true));
    await until(()=>f.registrations===3);c.abort();assert.equal((await foreground).error.name,'AbortError');assert.equal((await speculative).error.name,'AbortError');
    await tick();assert.equal(f.registrationRequests[2].destroyed,true,'single-use registration must be cancelled with its job');
    const next=await f.provider.prepare('123','789','',true,'range',false);
    assert.equal(next.mode,'range');assert.equal(f.registrations,4);assert.equal(f.requests.length,3);assert.equal(f.requests[2].device,'1234567890123456784');
  } finally {f.close();}
});

test('business, malformed and non-200 empty responses do not spend a second identity', async () => {
  for(const reply of [{status:204,empty:true},{body:'invalid JSON'},{body:'{"code":101000}'},{body:'{}'}]) {
    const f=fixture([reply]);
    try {assert((await observe(f.prepare(false))).error);assert.equal(f.registrations,2);assert.equal(f.requests.length,1);}
    finally {f.close();}
  }
  const whitespace=fixture([{body:' \n\t '},{body:' '},{body:'\r\n'},{}]);
  try {await whitespace.prepare(false);assert.equal(whitespace.requests.length,4);assert.equal(whitespace.registrations,3);}
  finally {whitespace.close();}
});

test('video_tab success returns immediately without legacy requests or fresh registrations', async () => {
  const model={data:{video_model_data:{'456':{video_model:{video_list:[{main_url:'https://media.example.test/tab.mp4',video_meta:{vheight:720},encrypt_info:{spade_a:spade()}}]}}}}};
  const f=fixture([],null,[],model);
  try {
    assert.equal((await f.prepare(false)).mode,'range');
    assert.equal(f.tabRequests.length,1);assert.equal(f.registrations,1);assert.equal(f.requests.length,0);
  } finally {f.close();}
});

test('an adopted prefetch does not retry a non-200 empty response in the outer recovery path', async () => {
  const f=fixture([{status:204,empty:true,hold:true},{}]);
  try {
    const speculative=observe(f.prepare(true));await until(()=>f.requests.length===1);
    const foreground=observe(f.prepare(false));f.requests[0].respond();
    assert.equal((await foreground).error.code,'VIDEO_MODEL_EMPTY');assert((await speculative).error);
    assert.equal(f.requests.length,1);assert.equal(f.registrations,2);
  } finally {f.close();}
});

test('shutdown and wake recreate the reusable video_tab identity and use a fresh legacy identity', async () => {
  const f=fixture([{}],null,[{hold:true},{},{}]),s=await service(f);
  try {
    const old=observe(f.prepare(false));await until(()=>f.registrations===1);
    await s.shutdown();assert.equal((await old).error.name,'AbortError');assert.equal(f.registrationRequests[0].destroyed,true);
    await s.ensureReady();const next=await f.prepare(false);assert.equal(next.mode,'range');assert.equal(f.registrations,3);assert.equal(f.requests.length,1);assert.equal(f.requests[0].device,'1234567890123456783');
  } finally {await s.shutdown();f.close();}
});
