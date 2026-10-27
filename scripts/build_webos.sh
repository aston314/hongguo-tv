#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out_dir=${WEBOS_OUTPUT_DIR:-"$repo_dir/dist/webos"}
stage_output=${WEBOS_STAGE_OUTPUT:-}
simulator_probe=${WEBOS_SIMULATOR_PROBE:-}
simulator_report_url=${WEBOS_SIMULATOR_REPORT_URL:-}
stage_service_base=${WEBOS_STAGE_SERVICE_BASE:-}
stage_connection_mode=${WEBOS_STAGE_CONNECTION_MODE:-}
stage_id_suffix=${WEBOS_STAGE_APP_ID_SUFFIX:-}
check_only=0
stage_package=0
if [ "${1:-}" = "--check-only" ]; then check_only=1; fi
if [ "${1:-}" = "--stage-package" ]; then stage_package=1; fi

if [ -n "$stage_service_base$stage_connection_mode$stage_id_suffix$simulator_probe$simulator_report_url" ] && [ -z "$stage_output" ]; then
  echo "WEBOS_STAGE_* and WEBOS_SIMULATOR_PROBE require WEBOS_STAGE_OUTPUT; test settings must stay in staging" >&2
  exit 2
fi
if [ -n "$stage_connection_mode" ] && [ "$stage_connection_mode" != "luna" ] && [ "$stage_connection_mode" != "http-direct" ]; then
  echo "WEBOS_STAGE_CONNECTION_MODE must be luna or http-direct" >&2
  exit 2
fi
if [ -n "$stage_service_base" ] && [ "$stage_connection_mode" != "http-direct" ]; then
  echo "WEBOS_STAGE_SERVICE_BASE is allowed only with http-direct test mode" >&2
  exit 2
fi
if [ "$stage_connection_mode" = "http-direct" ] && [ -z "$stage_service_base" ]; then
  echo "http-direct test mode requires WEBOS_STAGE_SERVICE_BASE" >&2
  exit 2
fi
if [ "$stage_package" -eq 1 ] && { [ -z "$stage_output" ] || [ "$check_only" -eq 1 ]; }; then
  echo "--stage-package requires WEBOS_STAGE_OUTPUT and cannot be combined with --check-only" >&2
  exit 2
fi
if [ "$stage_package" -eq 1 ] && [ -z "$stage_id_suffix" ]; then
  echo "--stage-package requires WEBOS_STAGE_APP_ID_SUFFIX to avoid replacing another installed app" >&2
  exit 2
fi
if [ -n "$stage_id_suffix" ] && ! printf '%s\n' "$stage_id_suffix" | grep -Eq '^\.[a-z0-9-]{1,24}$'; then
  echo "WEBOS_STAGE_APP_ID_SUFFIX must look like .run6-http" >&2
  exit 2
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/hongguo-webos.XXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT INT TERM

app_stage="$stage/app"
service_stage="$stage/service"
mkdir -p "$app_stage" "$service_stage"
cp -R "$repo_dir/core/cmd/hongguotv/ui/." "$app_stage/"
cp "$repo_dir/webos/appinfo.json" "$app_stage/appinfo.json"
cp "$repo_dir/webos/app/webos-adapter.js" "$app_stage/webos-adapter.js"
for audio_asset in webos-audio-controller.js webos-audio-local.js webos-audio.js webos-audio-worker.js webos-wsola.js; do
  cp "$repo_dir/webos/app/$audio_asset" "$app_stage/$audio_asset"
done
cp "$repo_dir/webos/app/webos-updates.js" "$app_stage/webos-updates.js"
cp "$repo_dir/webos/service/update-manifest.js" "$app_stage/webos-update-manifest.js"
node - "$app_stage/webos-adapter.js" "$app_stage/appinfo.json" <<'NODE'
var fs = require('fs');
var adapterPath = process.argv[2];
var appInfoPath = process.argv[3];
var adapter = fs.readFileSync(adapterPath, 'utf8');
var appInfo = JSON.parse(fs.readFileSync(appInfoPath, 'utf8'));
var marker = "appVersion: ''";
if (adapter.indexOf(marker) < 0) throw new Error('webOS adapter appVersion placeholder missing');
fs.writeFileSync(adapterPath, adapter.replace(marker, 'appVersion: ' + JSON.stringify(appInfo.version)));
NODE
mkdir -p "$app_stage/webOSTVjs-1.2.13"
cp "$repo_dir/webos/app/webOSTVjs-1.2.13/webOSTV.js" "$app_stage/webOSTVjs-1.2.13/webOSTV.js"
cp "$repo_dir/webos/app/webOSTVjs-1.2.13/LICENSE-2.0.txt" "$app_stage/webOSTVjs-1.2.13/LICENSE-2.0.txt"
cp "$repo_dir/desktop/resources/appicon.png" "$app_stage/icon.png"
cp "$repo_dir/desktop/resources/appicon.png" "$app_stage/largeIcon.png"
cp -R "$repo_dir/webos/service/." "$service_stage/"
# Test vectors and local test harnesses stay in the source tree and are
# exercised by CI; do not ship them in the TV service package.
rm -f "$service_stage/passport-sign.test.js" "$service_stage/provider.test.js" "$service_stage/account.test.js" "$service_stage/service.test.js" "$service_stage/service-entry.test.js" "$service_stage/number-input.test.js" "$service_stage/range-media.test.js" "$service_stage/search-season.test.js"
rm -f "$service_stage/media-cache.test.js"
rm -f "$service_stage/updates.test.js"

# A file:// document cannot resolve the shared UI's root-absolute assets.
index="$app_stage/index.html"
sed -i.bak \
  -e 's#src="/#src="./#g' \
  -e 's#href="/#href="./#g' \
  "$index"
rm -f "$index.bak"
sed -i.bak 's#<script src="./compat.js"></script>#<script src="./webOSTVjs-1.2.13/webOSTV.js"></script><script src="./webos-update-manifest.js"></script><script src="./webos-updates.js"></script><script src="./webos-adapter.js"></script><script src="./compat.js"></script>#' "$index"
sed -i.bak 's#<script src="./app.js"></script>#<script src="./webos-audio-controller.js"></script><script src="./webos-audio-local.js"></script><script src="./webos-audio.js"></script><script src="./app.js"></script>#' "$index"
rm -f "$index.bak"

if [ -n "$stage_output" ]; then
  case "$stage_output" in
    "$HOME"/*) ;;
    *) echo "WEBOS_STAGE_OUTPUT must be inside HOME because Simulator services are loaded from there" >&2; exit 2 ;;
  esac
  [ ! -e "$stage_output" ] || { echo "WEBOS_STAGE_OUTPUT already exists: $stage_output" >&2; exit 2; }
  mkdir -p "$(dirname -- "$stage_output")"
  mkdir "$stage_output"
  cp -R "$app_stage" "$stage_output/app"
  cp -R "$service_stage" "$stage_output/service"
  if [ -n "$stage_connection_mode" ] || [ -n "$stage_service_base" ] || [ -n "$stage_id_suffix" ] || [ -n "$simulator_report_url" ]; then
    node - "$stage_output/app" "$stage_output/service" "$stage_connection_mode" "$stage_service_base" "$stage_id_suffix" "$simulator_report_url" <<'NODE'
var fs = require('fs');
var path = require('path');
var appRoot = process.argv[2];
var serviceRoot = process.argv[3];
var mode = process.argv[4] || 'luna';
var base = process.argv[5] || '';
var suffix = process.argv[6] || '';
var reportURL = process.argv[7] || '';
var file = path.join(appRoot, 'webos-adapter.js');
var source = fs.readFileSync(file, 'utf8');
if (base && !/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(base)) throw new Error('stage HTTP base must be an explicit IPv4 host and port');
if (reportURL && !/^http:\/\/(?:127\.0\.0\.1|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}):\d{1,5}\/report$/.test(reportURL)) throw new Error('stage report URL must use loopback or a private IPv4 address');
var appInfoPath = path.join(appRoot, 'appinfo.json');
var appInfo = JSON.parse(fs.readFileSync(appInfoPath, 'utf8'));
var appId = appInfo.id;
var packagePath = path.join(serviceRoot, 'package.json');
var servicePackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
var serviceId = servicePackage.name;
var baseAppId = appId;
var baseServiceId = serviceId;
if (suffix) {
  appId += suffix;
  serviceId = appId + '.service';
  appInfo.id = appId;
  servicePackage.name = serviceId;
  fs.writeFileSync(appInfoPath, JSON.stringify(appInfo, null, 2) + '\n');
  fs.writeFileSync(packagePath, JSON.stringify(servicePackage, null, 2) + '\n');
  var servicesPath = path.join(serviceRoot, 'services.json');
  var services = JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
  services.id = serviceId;
  services.services.forEach(function (service) { service.name = serviceId; });
  fs.writeFileSync(servicesPath, JSON.stringify(services, null, 2) + '\n');
  var servicePath = path.join(serviceRoot, 'service.js');
  var serviceSource = fs.readFileSync(servicePath, 'utf8').replace("var SERVICE_ID = 'com.aston314.hongguo.webos.service';", "var SERVICE_ID = '" + serviceId + "';");
  fs.writeFileSync(servicePath, serviceSource);
  var providerPath = path.join(serviceRoot, 'provider.js');
  var providerSource = fs.readFileSync(providerPath, 'utf8').replace(/com\.aston314\.hongguo\.webos\.service/g, serviceId);
  fs.writeFileSync(providerPath, providerSource);
}
source = source.replace("var SERVICE_URI = 'luna://com.aston314.hongguo.webos.service';", "var SERVICE_URI = 'luna://" + serviceId + "';");
source = source.replace("var SERVICE_MODE = 'luna';", "var SERVICE_MODE = " + JSON.stringify(mode) + ";");
if (base) source = source.replace("var SERVICE_BASE = 'http://127.0.0.1:7655';", "var SERVICE_BASE = " + JSON.stringify(base) + ";");
if (source.indexOf("var SERVICE_MODE = " + JSON.stringify(mode) + ";") < 0 || source.indexOf("var SERVICE_URI = 'luna://" + serviceId + "';") < 0 || base && source.indexOf("var SERVICE_BASE = " + JSON.stringify(base) + ";") < 0) throw new Error('failed to inject stage-only webOS configuration');
fs.writeFileSync(file, source);
if (suffix) {
  var manifest = { app_id: appId, service_id: serviceId, base_app_id: baseAppId, base_service_id: baseServiceId, connection_mode: mode || 'luna', service_base: base || 'http://127.0.0.1:7655', report_url: reportURL || '', staging_only: true };
  fs.writeFileSync(path.join(appRoot, 'webos-stage-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
if (reportURL) fs.writeFileSync(path.join(appRoot, 'webos-simulator-config.js'), 'window.HongguoWebOSSimulatorConfig = { reportURL: ' + JSON.stringify(reportURL) + ' };\n');
NODE
  fi
  if [ -n "$simulator_probe" ]; then
    [ -f "$simulator_probe" ] || { echo "WEBOS_SIMULATOR_PROBE not found: $simulator_probe" >&2; exit 2; }
    cp "$simulator_probe" "$stage_output/app/webos-simulator-probe.js"
    if [ -f "$stage_output/app/webos-simulator-config.js" ]; then
      sed -i.bak 's#<script src="./app.js"></script>#<script src="./webos-simulator-config.js"></script><script src="./webos-simulator-probe.js"></script><script src="./app.js"></script>#' "$stage_output/app/index.html"
    else
      sed -i.bak 's#<script src="./app.js"></script>#<script src="./webos-simulator-probe.js"></script><script src="./app.js"></script>#' "$stage_output/app/index.html"
    fi
    rm -f "$stage_output/app/index.html.bak"
  fi
  echo "staging: $stage_output"
fi

if [ "$check_only" -eq 1 ]; then
  echo "webOS staging verified: $app_stage"
  exit 0
fi

ares_package=${ARES_PACKAGE:-}
if [ -z "$ares_package" ]; then
  if command -v ares-package >/dev/null 2>&1; then ares_package=$(command -v ares-package)
  elif [ -n "${ARES_DIR:-}" ] && [ -f "$ARES_DIR/node_modules/@webos-tools/cli/bin/ares-package.js" ]; then ares_package="node $ARES_DIR/node_modules/@webos-tools/cli/bin/ares-package.js"
  fi
fi
if [ -z "$ares_package" ]; then
  echo "ares-package not found; staging is valid but no .ipk was produced" >&2
  echo "Install @webos-tools/cli or set ARES_PACKAGE to ares-package" >&2
  exit 2
fi

if [ "$stage_package" -eq 1 ]; then
  test_out="$stage_output/test-ipk"
  mkdir -p "$test_out"
  # shellcheck disable=SC2086
  $ares_package -o "$test_out" "$stage_output/app" "$stage_output/service"
  ipk=$(ls -t "$test_out"/*.ipk 2>/dev/null | head -1 || true)
  [ -n "$ipk" ] || { echo "ares-package completed without a staged test .ipk" >&2; exit 1; }
  python3 "$repo_dir/scripts/verify_webos_ipk.py" --staging "$ipk"
  echo "test-only artifact: $ipk"
  exit 0
fi

mkdir -p "$out_dir"
# Package the clean build tree only. Stage IP, mode and probe are never copied
# back into these production app/service sources.
# shellcheck disable=SC2086
$ares_package -o "$out_dir" "$app_stage" "$service_stage"
ipk=$(ls -t "$out_dir"/*.ipk 2>/dev/null | head -1 || true)
[ -n "$ipk" ] || { echo "ares-package completed without an .ipk" >&2; exit 1; }
echo "artifact: $ipk"
