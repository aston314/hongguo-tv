#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_bin=${NODE:-node}

"$node_bin" --check "$repo_dir/scripts/run_webos_http_direct_service.js"
"$node_bin" --check "$repo_dir/webos/service/range-media.js"
"$node_bin" --check "$repo_dir/webos/service/account-scan.js"
"$node_bin" --check "$repo_dir/webos/app/webos-updates.js"
"$node_bin" --check "$repo_dir/webos/app/webos-audio-controller.js"
"$node_bin" --check "$repo_dir/webos/app/webos-audio-local.js"
"$node_bin" --check "$repo_dir/webos/app/webos-audio.js"
"$node_bin" --check "$repo_dir/webos/app/webos-audio-worker.js"
"$node_bin" --check "$repo_dir/webos/app/webos-wsola.js"
"$node_bin" --check "$repo_dir/webos/service/audio-media.js"
"$node_bin" --check "$repo_dir/webos/service/audio-range.js"
"$node_bin" --check "$repo_dir/webos/service/audio-multipart.js"
"$node_bin" --check "$repo_dir/webos/service/audio-cancel.js"

"$node_bin" - "$repo_dir" <<'NODE'
var fs = require('fs');
var path = require('path');
var root = process.argv[2];
function fail(message) { console.error('webOS verify: ' + message); process.exit(1); }
function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch (error) { fail('missing ' + path.relative(root, file)); } }
function json(file) { try { return JSON.parse(read(file)); } catch (error) { fail('invalid JSON ' + path.relative(root, file) + ': ' + error.message); } }
var app = json(path.join(root, 'webos', 'appinfo.json'));
['id', 'version', 'type', 'main', 'icon', 'largeIcon'].forEach(function (key) { if (!app[key]) fail('appinfo missing ' + key); });
if (app.id !== 'com.aston314.hongguo.webos') fail('unexpected app id');
if (app.type !== 'web') fail('appinfo type must be web');
if (app.main !== 'index.html') fail('app main must be index.html');
var service = json(path.join(root, 'webos', 'service', 'services.json'));
if (!service.services || !service.services.length || service.services[0].name !== 'com.aston314.hongguo.webos.service') fail('service id mismatch');
var commands = service.services[0].commands || [];
['ping', 'getDiagnostics', 'shutdown'].forEach(function (name) {
  var command = commands.filter(function (entry) { return entry.name === name; })[0];
  if (!command || command.public !== true) fail('service command must be declared public: ' + name);
});
var servicePackage = json(path.join(root, 'webos', 'service', 'package.json'));
if (servicePackage.name !== service.services[0].name || servicePackage.main !== 'service-entry.js') fail('service package must declare its registered id and bootstrap entry point');
if (servicePackage.version !== app.version) fail('service package version must match app version');
if (!fs.existsSync(path.join(root, 'webos', 'service', servicePackage.main))) fail('service entry point is missing');
var index = read(path.join(root, 'core', 'cmd', 'hongguotv', 'ui', 'index.html'));
['core-connection-modal', 'core-connection-scroll', 'core-connection-retry', 'core-connection-close'].forEach(function (id) { if (index.indexOf('id="' + id + '"') < 0) fail('shared UI missing connection diagnostic element ' + id); });
var scripts = [];
index.replace(/(?:src|href)=["']([^"']+)["']/g, function (_, value) { if (/\.(?:js|css)$/.test(value)) scripts.push(value.replace(/^\//, '')); return value; });
if (scripts.length < 10) fail('shared UI asset list unexpectedly small');
if (scripts.indexOf('auto-cinema.js') < 0) fail('auto cinema preference module is not loaded by the shared UI');
if (!fs.existsSync(path.join(root, 'webos', 'app', 'webos-adapter.js'))) fail('webOS adapter missing');
if (!fs.existsSync(path.join(root, 'webos', 'app', 'webOSTVjs-1.2.13', 'webOSTV.js'))) fail('official webOSTV.js library missing');
var adapter = read(path.join(root, 'webos', 'app', 'webos-adapter.js'));
if (adapter.indexOf("appVersion: ''") < 0) fail('webOS adapter is missing the build version placeholder');
if (adapter.indexOf('playbackVerified: false') < 0 || adapter.indexOf('isAvailable: function () { return false; }') < 0) fail('adapter must keep native playback disabled');
if (adapter.indexOf('PalmServiceBridge') < 0 || adapter.indexOf('wakeService') < 0 || adapter.indexOf('XMLHttpRequest') < 0 || adapter.indexOf('method: method') < 0 || adapter.indexOf('/api/v1/health') < 0 || adapter.indexOf('getDiagnostic') < 0) fail('adapter must expose compatible Luna and HTTP health diagnostics before fetch and XHR calls');
if (adapter.indexOf("var SERVICE_BASE = 'http://127.0.0.1:7655';") < 0 || adapter.indexOf("var SERVICE_MODE = 'luna';") < 0) fail('production adapter must keep loopback Luna defaults');
var serviceJs = read(path.join(root, 'webos', 'service', 'service.js'));
['webos-service', '127.0.0.1', 'WEBOS_PROVIDER_NOT_IMPLEMENTED', '/api/v1/status', '/api/v1/health', '/api/v1/diagnostics', 'http_bind', 'manager.create', 'manager.complete', 'Access-Control-Allow-Private-Network'].forEach(function (term) { if (serviceJs.indexOf(term) < 0) fail('service missing ' + term); });
var providerJs = read(path.join(root, 'webos', 'service', 'provider.js'));
var signerJs = read(path.join(root, 'webos', 'service', 'passport-sign.js'));
['video_model', 'spade_a', 'decryptMP4', 'serveMedia', 'randomBytes', 'cenc-aes-ctr'].forEach(function (term) { if (providerJs.indexOf(term) < 0 && serviceJs.indexOf(term) < 0) fail('real provider missing ' + term); });
['X-Medusa', 'X-Helios', 'passportF13', 'aesV3'].forEach(function (term) { if (signerJs.indexOf(term) < 0) fail('passport signer missing ' + term); });
if (serviceJs.indexOf("require('./provider')") < 0) fail('service does not load first-party provider');
if (/127\.0\.0\.1:(?:8787|8797|57828)/.test(adapter + serviceJs)) fail('developer-only port leaked into webOS adapter/service');
if (fs.existsSync(path.join(root, 'webos', 'service', 'number-input.test.js'))) require(path.join(root, 'webos', 'service', 'number-input.test.js'));
if (fs.existsSync(path.join(root, 'webos', 'app', 'webos-adapter.test.js'))) require(path.join(root, 'webos', 'app', 'webos-adapter.test.js'));
if (fs.existsSync(path.join(root, 'webos', 'service', 'service.test.js'))) require(path.join(root, 'webos', 'service', 'service.test.js'));
console.log('webOS verify: PASS');
console.log(JSON.stringify({ appId: app.id, version: app.version, serviceId: service.services[0].name, sharedUiAssets: scripts.length, playbackVerified: false }, null, 2));
NODE

"$node_bin" "$repo_dir/webos/service/passport-sign.test.js"
"$node_bin" "$repo_dir/webos/service/provider.test.js"
"$node_bin" "$repo_dir/webos/service/search-season.test.js"
"$node_bin" --test "$repo_dir/tests/webos-prefetch-recovery.test.cjs"
"$node_bin" --test "$repo_dir/tests/webos-audio-controller.test.cjs" "$repo_dir/tests/webos-audio-local.test.cjs" "$repo_dir/tests/webos-audio-install.test.cjs"
"$node_bin" "$repo_dir/webos/service/media-cache.test.js"
"$node_bin" "$repo_dir/webos/service/updates.test.js"
"$node_bin" "$repo_dir/webos/service/range-media.test.js"
"$node_bin" "$repo_dir/webos/service/account.test.js"
"$node_bin" --test "$repo_dir/webos/service/account-scan.test.js"
"$node_bin" "$repo_dir/webos/service/service-entry.test.js"
"$node_bin" --test "$repo_dir/tests/webos-single-player-prefetch.test.cjs" "$repo_dir/tests/webos-range-head-cache.test.cjs" "$repo_dir/tests/next-episode-transition.test.cjs"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/hongguo-webos-verify.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
WEBOS_OUTPUT_DIR="$tmp" "$repo_dir/scripts/build_webos.sh" --check-only >/dev/null
echo "webOS verify: staging command PASS"

stage_parent=$(mktemp -d "$HOME/.webos-verify.XXXXXX")
stage_test="$stage_parent/stage"
WEBOS_STAGE_OUTPUT="$stage_test" WEBOS_STAGE_APP_ID_SUFFIX=.verify \
  WEBOS_STAGE_CONNECTION_MODE=http-direct WEBOS_STAGE_SERVICE_BASE=http://192.168.2.124:7655 \
  WEBOS_SIMULATOR_REPORT_URL=http://127.0.0.1:17658/report \
  WEBOS_SIMULATOR_PROBE="$repo_dir/scripts/webos_simulator_probe.js" \
  "$repo_dir/scripts/build_webos.sh" --check-only >/dev/null
node - "$stage_test" <<'NODE'
var fs = require('fs');
var path = require('path');
var root = process.argv[2];
var app = JSON.parse(fs.readFileSync(path.join(root, 'app', 'appinfo.json'), 'utf8'));
var adapter = fs.readFileSync(path.join(root, 'app', 'webos-adapter.js'), 'utf8');
var service = JSON.parse(fs.readFileSync(path.join(root, 'service', 'services.json'), 'utf8'));
if (app.id !== 'com.aston314.hongguo.webos.verify') throw new Error('staging app id was not isolated');
if (service.id !== 'com.aston314.hongguo.webos.verify.service') throw new Error('staging service id was not isolated');
if (adapter.indexOf("var SERVICE_MODE = \"http-direct\";") < 0 || adapter.indexOf("var SERVICE_BASE = \"http://192.168.2.124:7655\";") < 0) throw new Error('staging HTTP configuration was not injected');
if (fs.existsSync(path.join(root, 'app', 'webos-stage-manifest.json')) === false) throw new Error('staging manifest missing');
var html = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');
var controllerAt = html.indexOf('src="./webos-audio-controller.js"');
var localAt = html.indexOf('src="./webos-audio-local.js"');
var audioAt = html.indexOf('src="./webos-audio.js"');
if (controllerAt < 0 || localAt <= controllerAt || audioAt <= localAt || audioAt >= html.indexOf('src="./app.js"')) throw new Error('webOS audio modules must load before the shared application');
if (!fs.existsSync(path.join(root, 'app', 'webos-audio-local.js'))) throw new Error('webOS local audio asset missing');
['webos-audio-worker.js', 'webos-wsola.js'].forEach(function (file) { if (!fs.existsSync(path.join(root, 'app', file))) throw new Error('audio worker asset missing'); });
['audio-media.js', 'audio-range.js', 'audio-cancel.js', 'audio-multipart.js'].forEach(function (file) { if (!fs.existsSync(path.join(root, 'service', file))) throw new Error('audio service asset missing'); });
if (fs.readFileSync(path.join(root, 'app', 'webos-simulator-config.js'), 'utf8').indexOf('http://127.0.0.1:17658/report') < 0) throw new Error('staging report URL was not injected');
console.log('webOS staged configuration: PASS');
NODE
rm -rf "$stage_parent"
