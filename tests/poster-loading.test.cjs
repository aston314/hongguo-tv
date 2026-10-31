const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const functions = source.slice(source.indexOf('  function setCover('), source.indexOf('  function setFeatured('));
function posters() {
  const c=vm.createContext({});
  vm.runInContext(`
    var images=[],frames=[];
    function Image(){this.style={};this.names=[];this.complete=false;this.naturalWidth=0;images.push(this);}
    Image.prototype.getAttribute=function(name){return this[name]||null};
    Image.prototype.removeAttribute=function(name){delete this[name]};
    function node(){var image=new Image();image.classList={add:function(name){if(image.names.indexOf(name)<0)image.names.push(name)},remove:function(name){var at=image.names.indexOf(name);if(at>=0)image.names.splice(at,1)}};return image;}
    function requestAnimationFrame(fn){frames.push(fn)}
    function paint(){while(frames.length)frames.shift()()}
  `+functions,c);
  return c;
}
test('poster pixels stay hidden until loaded and laid out, without changing the reserved dimensions', () => {
  const c=posters();
  vm.runInContext(`image=node();image.style.width='100%';image.style.height='100%';setCover(image,{title:'剧',cover:'poster.jpg'})`,c);
  assert.equal(c.image.names.includes('is-cover-pending'),true);
  c.image.onload();assert.equal(c.image.names.includes('is-cover-pending'),true);
  c.paint();assert.equal(c.image.names.includes('is-cover-pending'),false);
  assert.equal(c.image.style.width,'100%');assert.equal(c.image.style.height,'100%');
  const oldLoaded=c.image.onload;
  c.setCover(c.image,{cover:'next.jpg'});oldLoaded();c.paint();
  assert.equal(c.image.names.includes('is-cover-pending'),true);
  c.image.onload();c.paint();assert.equal(c.image.names.includes('is-cover-pending'),false);
});
test('a failed cover does not display a broken or stretched image and recovers on another cover', () => {
  const c=posters();vm.runInContext(`image=node();setCover(image,{cover:'bad.jpg'})`,c);
  c.image.onerror();assert.equal(c.image.src,undefined);assert.equal(c.image.names.includes('is-cover-pending'),true);
  c.setCover(c.image,{cover:'good.jpg'});c.image.onload();c.paint();
  assert.equal(c.image.names.includes('is-empty'),false);assert.equal(c.image.names.includes('is-cover-pending'),false);
});
test('loading poster layers reveal the decoded current source together and reject late previous images', () => {
  const c=posters();vm.runInContext(`backdrop=node();poster=node();setBackdrop(backdrop,{cover:'first.jpg'},poster);first=backdrop.__coverLoader;setBackdrop(backdrop,{cover:'second.jpg'},poster);second=backdrop.__coverLoader`,c);
  c.first.onload();c.paint();assert.equal(c.backdrop.style.backgroundImage,'none');assert.equal(c.poster.style.backgroundImage,'none');
  c.second.onload();assert.equal(c.backdrop.names.includes('is-cover-pending'),true);
  assert.equal(c.poster.names.includes('is-cover-pending'),true);
  c.paint();assert.equal(c.backdrop.style.backgroundImage,'url("second.jpg")');
  assert.equal(c.poster.style.backgroundImage,'url("second.jpg")');
  assert.equal(c.backdrop.names.includes('is-cover-pending'),false);
  assert.equal(c.poster.names.includes('is-cover-pending'),false);
  const count=c.images.length;c.setBackdrop(c.backdrop,{cover:'second.jpg'},c.poster);assert.equal(c.images.length,count);
  c.setBackdrop(c.backdrop,{cover:'bad.jpg'},c.poster);c.backdrop.__coverLoader.onerror();
  assert.equal(c.backdrop.style.backgroundImage,'url("second.jpg")');assert.equal(c.poster.style.backgroundImage,'url("second.jpg")');
});

test('a loaded poster stays visible while the next episode cover is decoding', () => {
  const c=posters();
  vm.runInContext(`backdrop=node();poster=node();setBackdrop(backdrop,{cover:'first.jpg'},poster);first=backdrop.__coverLoader;first.onload();paint();setBackdrop(backdrop,{cover:'second.jpg'},poster);second=backdrop.__coverLoader`,c);
  assert.equal(c.backdrop.style.backgroundImage,'url("first.jpg")');
  assert.equal(c.poster.style.backgroundImage,'url("first.jpg")');
  assert.equal(c.backdrop.names.includes('is-cover-pending'),false);
  assert.equal(c.poster.names.includes('is-cover-pending'),false);
  c.second.onload();c.paint();
  assert.equal(c.backdrop.style.backgroundImage,'url("second.jpg")');
  assert.equal(c.poster.style.backgroundImage,'url("second.jpg")');
});

function featuredPosters({ android=false, webos=false }={}) {
  const c=posters();
  Object.assign(c,{androidShell:android,webosShell:webos});
  vm.runInContext(`
    var backdrop=node(),poster=node(),engagement=null;
    var document={getElementById:function(id){return id==='hero-backdrop'?backdrop:id==='hero-loading-poster'?poster:null},querySelector:function(){return null}};
    function updateSavedButtons(){}function setControlIcon(){}function updateSeasonControl(){}
    function uiText(key,fallback){return fallback}
  `+source.slice(source.indexOf('  function setFeatured('),source.indexOf('  function updateFeedCounter(')),c);
  return c;
}
test('same-drama artwork is cleared on all platforms even when the old poster loads late', () => {
  for(const platform of [{android:true},{android:false},{webos:true}])for(const loaded of [false,true]) {
    const c=featuredPosters(platform);
    c.setBackdrop(c.backdrop,{cover:'drama.jpg'},c.poster);
    const old=c.backdrop.__coverLoader;
    if(loaded)old.onload(); // Its pending animation callback must also be invalidated.
    c.setFeatured({series_id:'one',cover:'drama.jpg'},false,'episode');
    old.onload();c.paint();
    assert.equal(c.backdrop.style.backgroundImage,'none');
    assert.equal(c.poster.style.backgroundImage,'none');
    assert.equal(c.backdrop.__coverLoader,null);
    c.setFeatured({series_id:'one',cover:'drama.jpg'},false,'refresh');
    assert.equal(c.backdrop.__coverLoader,null,'detail/stats refresh cannot restore the drama poster');
  }
});
test('first playback and switching dramas load the target poster after a suppressed episode transition', () => {
  for(const android of [false,true])for(const kind of ['initial','series']) {
    const c=featuredPosters({android});
    c.setFeatured({series_id:'one',cover:'old.jpg'},false,'episode');
    c.setFeatured({series_id:'two',cover:'target.jpg'},false,kind);
    c.backdrop.__coverLoader.onload();c.paint();
    assert.equal(c.backdrop.style.backgroundImage,'url("target.jpg")');
    assert.equal(c.poster.style.backgroundImage,'url("target.jpg")');
  }
});
test('webOS follows the same no-drama-poster rule for episode switches', () => {
  const c=featuredPosters({webos:true});
  c.setFeatured({series_id:'one',cover:'drama.jpg'},false,'episode');
  assert.equal(c.backdrop.__coverLoader,null);
  assert.equal(c.poster.style.backgroundImage,'none');
});
