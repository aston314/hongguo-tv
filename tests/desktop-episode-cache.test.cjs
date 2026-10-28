const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const desktopUI = require('../core/cmd/hongguotv/ui/desktop.js');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const media = '/minireel-proxy/media/' + 'a1'.repeat(12) + '.mp4';
const completed = '/minireel-proxy/media/' + 'b2'.repeat(12) + '.mp4';
const target = {series_id:'123',vid:'456',quality:'720P',fallback:'0'};

function fixture({base='http://127.0.0.1:34567',desktop=true}={}) {
  const calls=[];
  let callbacks;
  const context=vm.createContext({Promise,URLSearchParams,Object,Number,
    desktopShell:desktop,
    window:desktop ? {HongguoDesktop:{mediaBase:base},HongguoDesktopUI:desktopUI} : {},
    HongguoEpisodePrefetch:{create(options){callbacks=options;return {}; }},
    fetch:async(url,options)=>{
      calls.push({url,options});
      return {ok:true,json:async()=>({ok:true,data:{path:url.startsWith('/api/v1/play/cache?') ? completed : media,vid:'456',quality:'720P',mode:url.startsWith('/api/v1/play/cache?') ? 'full' : 'range'}})};
    }
  });
  const helper=source.slice(source.indexOf('  function preparedMediaPath('),source.indexOf('  function listStatus('));
  const setup=source.slice(source.indexOf('  var episodePrefetch = HongguoEpisodePrefetch.create('),source.indexOf('  var applicationInBackground ='));
  assert.ok(helper && setup,'production cache setup and helpers must exist');
  vm.runInContext(helper + setup,context);
  return {context,callbacks,calls};
}

test('desktop Range source completes the real fetchData-to-cache path using the current dynamic core port',async()=>{
  for(const port of [49152,57773,65535]) {
    const base='http://127.0.0.1:'+port;
    const f=fixture({base}),controller=new AbortController();
    const prepared=await f.callbacks.prepare(target,controller.signal);
    assert.equal(prepared.path,base+media,'normal desktop media rewriting remains active');
    const result=await f.callbacks.cache(prepared,controller.signal,target);
    assert.equal(f.calls.length,2);
    const request=f.calls[1];
    assert.equal(request.options.method,'POST');
    assert.equal(request.options.signal,controller.signal);
    assert.equal(new URL(request.url,'http://app.invalid').searchParams.get('media'),media);
    assert.equal(result.path,base+completed,'completed file remains playable through the desktop media port');
    assert.equal(result.mode,'full');
    assert.equal(prepared.path,base+media,'normalizing the request must not mutate the prepared playback source');
  }
});

test('Android and webOS do not enable the optional full-file cache',()=>{
  assert.equal(fixture({desktop:false}).callbacks.cache,null);
});

test('foreign, mismatched-port and malformed prepared sources are rejected without a request or fallback resolver',async()=>{
  const f=fixture(),base='http://127.0.0.1:34567';
  for(const path of [
    'https://foreign.invalid'+media,'http://127.0.0.1:34568'+media,
    'http://localhost:34567'+media,'https://127.0.0.1:34567'+media,
    'http://user:pass@127.0.0.1:34567'+media,base+'@foreign.invalid'+media,
    '//127.0.0.1:34567'+media,base+media+'?extra=1',base+media+'#fragment',
    base+'/minireel-proxy/media/../'+media.split('/').at(-1),
    base+'/minireel-proxy/media/%2e%2e/'+media.split('/').at(-1),
    base+'/minireel-proxy/media/'+'A'.repeat(24)+'.mp4',
    base+'/minireel-proxy/media/short.mp4',base+'/api/v1/account',
    media+'?extra=1',media+'#fragment',{path:media}
  ]) {
    await assert.rejects(f.callbacks.cache({path},undefined,target),/媒体地址无效/);
  }
  assert.equal(f.calls.length,0);
});

test('absolute source normalization requires a valid configured loopback media base',async()=>{
  for(const base of [
    'https://foreign.invalid','http://localhost:34567','https://127.0.0.1:34567',
    'http://user:pass@127.0.0.1:34567','http://127.0.0.1:0','http://127.0.0.1:65536',
    'http://127.0.0.1:34567/extra','http://127.0.0.1:34567/',null
  ]) {
    const f=fixture({base});
    await assert.rejects(f.callbacks.cache({path:base+media},undefined,target),/媒体地址无效/);
    assert.equal(f.calls.length,0);
    assert.equal(f.context.preparedMediaPath(media),media,'a valid relative token does not need desktop conversion');
  }

});

