const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {create} = require('../core/cmd/hongguotv/ui/numeric-keypad.js');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const keys = source.slice(source.indexOf('  function normalizedKey('), source.indexOf('  function showNotice('));
const keyNames = source.match(/  var keyNames = \{[\s\S]*?\n  \};/)[0];
function router() {
  const c=vm.createContext({});
  vm.runInContext(`
    var document={activeElement:{id:'app-check-update'}},moved=[];
    var numericKeypad,searchSuggestionActivation=null;function accountKeypadOpen(){return numericKeypad.isOpen()}
    function moveFrom(current,direction){moved.push(direction)}
    function handleBack(){return true}function handleMediaCommand(){return false}
    function handleEndRecommendationKey(){return false}
  ` + keyNames + keys,c);
  c.changes=[];c.closes=[];
  c.numericKeypad=create({change:(kind,value)=>c.changes.push({kind,value}),close:r=>c.closes.push(r)});
  return c;
}
function key(c,event){let prevented=0,stopped=0;c.handleKey({...event,preventDefault(){prevented++},stopPropagation(){stopped++}});return [prevented,stopped]}
test('legacy Android vertical bridge stays within the numeric keyboard, including edges',()=>{
  const c=router();c.numericKeypad.open('phone','');
  for(let i=0;i<10;i++) assert.equal(c.remoteKey(20,false),true);
  assert.equal(c.numericKeypad.snapshot().index,9);assert.equal(c.moved.length,0);
  for(let i=0;i<10;i++) c.remoteKey(19,false);
  assert.equal(c.numericKeypad.snapshot().index,0);assert.equal(c.moved.length,0);
});
test('legacy DOM digits and numpad keys enter the code while keeping its leading zero',()=>{
  const c=router();c.numericKeypad.open('code','');
  for(const keyCode of [48,97,98,99,100,101]) assert.deepEqual(key(c,{keyCode}),[1,1]);
  assert.equal(c.numericKeypad.snapshot().value,'012345');assert.equal(c.moved.length,0);
});
test('confirmation adds the selected digit once and other page shortcuts remain trapped',()=>{
  const c=router();c.numericKeypad.open('phone','');
  key(c,{keyCode:23});key(c,{keyCode:23,repeat:true});
  assert.equal(c.numericKeypad.snapshot().value,'1');
  for(const k of ['Tab','MediaPlayPause',' ']) assert.deepEqual(key(c,{key:k}),[1,1]);
  assert.equal(c.closes.length,0);assert.equal(c.moved.length,0);
});
test('legacy Tab stays on keyboard keys and Delete removes a digit',()=>{
  const c=router();c.numericKeypad.open('code','012345');
  key(c,{keyCode:9});assert.equal(c.numericKeypad.snapshot().index,1);
  key(c,{keyCode:46});assert.equal(c.numericKeypad.snapshot().value,'01234');
  assert.equal(c.moved.length,0);assert.equal(c.closes.length,0);
});
test('deletion removes a digit and Back closes once with retained input',()=>{
  const c=router();c.numericKeypad.open('code','012345');
  key(c,{keyCode:8});assert.equal(c.numericKeypad.snapshot().value,'01234');
  key(c,{keyCode:27});assert.equal(c.closes[0].value,'01234');assert.equal(c.closes[0].reason,'back');
  assert.equal(c.numericKeypad.close('back'),false);assert.equal(c.closes.length,1);
});
test('account number fields are buttons, not editable elements or IME bridge clients',()=>{
  const html=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'),'utf8');
  for(const id of ['account-phone','account-code']) {
    assert.match(html,new RegExp('<button[^>]*id="'+id+'"'));
    assert.doesNotMatch(html,new RegExp('<input[^>]*id="'+id+'"'));
  }
  assert.doesNotMatch(source,/HongguoTVInput\.startAccountEditing|accountEditingInput|accountInputBlur/);
});
test('country selector is a TV-focusable modal with mainland default and restores to phone entry',()=>{
  const html=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'),'utf8');
  const countries=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/phone-countries.js'),'utf8');
  assert.match(html,/id="account-country"[^>]*aria-haspopup="dialog"/);
  assert.match(html,/id="account-country-modal"[^>]*aria-hidden="true"/);
  assert.match(source,/accountPhoneCountryCode = '\+86'/);
  assert.match(source,/closeAccountCountryModal\(true\)/);
  assert.match(source,/closeAccountCountryModal\(false\)/);
  assert.match(countries,/\{ code: '\+852', localeKey: 'country\.hongKong', minLength: 8, maxLength: 8 \}/);
  assert.match(source,/country_code: accountPhoneCountryCode/);
});
test('country entry limits match the actual reference package, including leading-zero eleven-digit numbers',()=>{
  const countriesSource=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/phone-countries.js'),'utf8');
  const context=vm.createContext({});
  vm.runInContext(countriesSource,context);
  const countries=context.HongguoPhoneCountries;
  const evidence=JSON.parse(fs.readFileSync(require.resolve('../core/cmd/hongguotv/testdata/passport-international-v124.json'),'utf8'));
  assert.equal(countries.length,evidence.regions.length);
  for(const expected of evidence.regions){
    const policy=countries.find(c=>c.code===expected.code);
    assert.equal(policy.minLength,expected.min,expected.code);
    assert.equal(policy.maxLength,expected.max,expected.code);
    const pad=create({});
    pad.open('phone','',policy);
    for(const digit of expected.local) pad.press(digit);
    assert.equal(pad.snapshot().value,expected.local,expected.code+' was truncated');
  }
});
