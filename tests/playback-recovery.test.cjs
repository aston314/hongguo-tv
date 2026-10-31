const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../core/cmd/hongguotv/ui/playback-recovery.js');
const {preparationFailure} = require('../core/cmd/hongguotv/ui/playback-recovery.js');

test('refreshes a failed non-MPV source once and then stops', () => {
  const recovery = create({maxAttempts: 1});
  assert.equal(recovery.next({native: ''}), 'refresh');
  assert.equal(recovery.attempts(), 1);
  assert.equal(recovery.next({native: ''}), 'stop');
});

test('never automatically rebuilds an MPV session', () => {
  const recovery = create({maxAttempts: 1});
  assert.equal(recovery.next({native: 'mpv'}), 'stop');
  assert.equal(recovery.attempts(), 0);
});

test('reset starts a new bounded recovery window', () => {
  const recovery = create({maxAttempts: 1});
  assert.equal(recovery.next({}), 'refresh');
  recovery.reset();
  assert.equal(recovery.next({}), 'refresh');
});

test('preparation failures retain only safe current-request fields including a zero-byte HTTP 200', () => {
  const error={code:'VIDEO_MODEL_EMPTY',stage:'multi_video_model',message:'https://private.test?token=secret',videoModel:{
    code:'VIDEO_MODEL_OK',http_status:200,response_bytes:0,attempt:3,elapsed_ms:1280,
    video_id:'private-id',cookie:'private-cookie',url:'https://private.test?token=secret'
  }};
  assert.deepEqual(preparationFailure(error),{code:'VIDEO_MODEL_EMPTY',stage:'multi_video_model',http_status:200,response_bytes:0,attempt:3,elapsed_ms:1280});
  assert.equal(preparationFailure({...error,name:'AbortError'}),null);
  assert.equal(preparationFailure({...error,stage:'untrusted-stage'}),null);
  assert.equal(preparationFailure({...error,code:'https://private.test'}),null);
  assert.equal(preparationFailure({...error,code:{toString:()=> 'VIDEO_MODEL_EMPTY'}}),null);
  assert.deepEqual(preparationFailure({...error,videoModel:{http_status:NaN,response_bytes:-1,attempt:'3',elapsed_ms:Infinity}}),{code:'VIDEO_MODEL_EMPTY',stage:'multi_video_model'});
});

test('Go preparation metadata is whitelisted with one preceding Range failure and no invented HTTP', () => {
  const error={code:'MEDIA_DOWNLOAD_TRANSPORT_TIMEOUT',stage:'media_download',status:502,upstreamStatus:0,
    preparation:{http_status:NaN,elapsed_ms:3000,business_code:'101000',cookie:'secret',
      range_failure:{code:'RANGE_INIT_HTTP',stage:'range_init',http_status:403,elapsed_ms:150,
        url:'https://private',range_failure:{code:'PRIVATE',stage:'range_init'}}}};
  assert.deepEqual(preparationFailure(error),{code:error.code,stage:error.stage,elapsed_ms:3000,business_code:'101000',
    range_failure:{code:'RANGE_INIT_HTTP',stage:'range_init',http_status:403,elapsed_ms:150}});
  assert.deepEqual(preparationFailure({...error,preparation:{business_code:'secret',http_status:0,range_failure:{code:'SECRET',stage:'untrusted'}}}),{code:error.code,stage:error.stage});
  for(const stage of ['device_register','multi_video_model','fallback_api','source_select','range_init','media_download','media_decrypt','cache_write','playback_prepare'])
    assert.equal(preparationFailure({code:'PREPARE_FAILED',stage}).stage,stage);
});
