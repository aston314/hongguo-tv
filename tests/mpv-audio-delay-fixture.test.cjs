const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require.resolve('../docs/fixtures/mpv-audio-delay.html'),'utf8');
function fixture(){
 const calls=[],listeners={},buttons={};let interval;
 const diagnostic={audio_delay_test_enabled:true,audio_delay_ms:0,audio_rate:48000,audio_output:'audiotrack'};
 for(const id of ['panel','delay0','delay50','delay100','replay','back','actual','status'])buttons[id]={className:'',textContent:'',addEventListener(type,fn){this[type]=fn},focus(){if(this.focus)this.focus()},click(){calls.push(['click',id])}};
 // focus handlers are registered separately from the focus method.
 for(const b of Object.values(buttons))b.addEventListener=function(type,fn){this['on'+type]=fn};
 for(const b of Object.values(buttons))b.focus=function(){if(this.onfocus)this.onfocus()};
 const context=vm.createContext({Date,JSON,decodeURIComponent,location:{search:'?return=http%3A%2F%2F127.0.0.1%3A43100%2F',replace(url){calls.push(['navigate',url])}},window:{},document:{getElementById(id){return buttons[id]},addEventListener(type,fn){listeners[type]=fn}},setInterval(fn){interval=fn},HongguoNativePlayer:{setAudioDelayForTest(ms){calls.push(['delay',ms])},bounds(){},setVolume(){},play(id,payload){calls.push(['play',JSON.parse(payload)])},stop(){calls.push(['stop'])},diagnostics(){return JSON.stringify(diagnostic)}}});
 vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
 return {context,calls,buttons,diagnostic,tick:()=>interval(),key(code){listeners.keydown({keyCode:code,preventDefault(){}})}};
}
test('delay selection waits for the actual property readback before highlighting',()=>{
 const f=fixture();f.context.chooseDelay(-50);f.tick();
 assert.equal(f.buttons.delay0.className,'selected');assert.equal(f.buttons.delay50.className,'');
 f.diagnostic.audio_delay_ms=-50;f.tick();assert.equal(f.buttons.delay50.className,'selected');
 const count=f.calls.length;f.context.chooseDelay(-75);assert.equal(f.calls.length,count);
});
test('replaying uses the same original dialogue position and preserves the selected delay',()=>{
 const f=fixture();f.context.chooseDelay(-100);f.context.startTest(0,8,false);f.context.progress.position=40000;f.context.startTest(0,8,false);
 const plays=f.calls.filter(c=>c[0]==='play');assert.equal(plays.length,2);
 assert.equal(plays[0][1].start_position,8);assert.deepEqual(plays[0][1],plays[1][1]);
 assert.equal(plays[0][1].source.includes('eeeeeeeeeeeeeeeeeeeeeeee.mp4'),true);
 assert.equal(f.calls.filter(c=>c[0]==='delay').at(-1)[1],-100);
});
test('remote navigation reaches all controls and return resets the test compensation',()=>{
 const f=fixture();f.key(39);assert.equal(f.context.focusIndex,1);f.key(39);assert.equal(f.context.focusIndex,2);
 f.key(40);assert.equal(f.context.focusIndex,3);f.key(39);assert.equal(f.context.focusIndex,4);
 f.key(38);assert.equal(f.context.focusIndex,0);f.context.goBack();
 assert.deepEqual(f.calls.slice(-3),[['delay',0],['stop'],['navigate','http://127.0.0.1:43100/']]);
});
