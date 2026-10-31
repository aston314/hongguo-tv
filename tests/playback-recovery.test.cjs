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
