#!/usr/bin/env bash
# Distribution packaging is executed by desktop.yml on GitHub runners.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${GITHUB_ACTIONS:?Desktop packages are built on GitHub Actions}"
: "${HONGGUO_CORE_VERSION:?Set the exact version and commit}"
: "${APP_VERSION:?Set the product version}"
: "${DESKTOP_VERSION_CODE:?Set the desktop update code}"
: "${DESKTOP_PLATFORM:?darwin/universal or windows/amd64}"
cd "$ROOT_DIR"
mkdir -p desktop/build/darwin desktop/build/sidecar desktop/dist
cp desktop/resources/Info.plist desktop/build/darwin/Info.plist
if [[ "$DESKTOP_PLATFORM" == darwin/universal ]]; then
  cp desktop/resources/appicon-macos.png desktop/build/appicon.png
else
  cp desktop/resources/appicon.png desktop/build/appicon.png
fi
python3 - <<'PY'
import json, os
from pathlib import Path
path=Path('desktop/wails.json'); config=json.loads(path.read_text(encoding='utf-8'))
config['info']['productVersion']=os.environ['APP_VERSION']; path.write_text(json.dumps(config,ensure_ascii=False,indent=2),encoding='utf-8')
PY
if [[ "$DESKTOP_PLATFORM" == darwin/universal ]]; then
  for arch in amd64 arm64; do
    GOOS=darwin GOARCH="$arch" CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$HONGGUO_CORE_VERSION" -o "desktop/build/sidecar/core-$arch" ./core/cmd/hongguotv
  done
  lipo -create desktop/build/sidecar/core-amd64 desktop/build/sidecar/core-arm64 -output desktop/build/sidecar/hongguo-tv-core
else
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$HONGGUO_CORE_VERSION" -o desktop/build/sidecar/hongguo-tv-core.exe ./core/cmd/hongguotv
fi
cd desktop
export PATH="$(go env GOPATH)/bin:$PATH"
node frontend/build.mjs
wails build -clean -platform "$DESKTOP_PLATFORM" -webview2 browser -ldflags "-s -w -X main.version=$HONGGUO_CORE_VERSION -X main.desktopVersion=$APP_VERSION -X main.desktopVersionCode=$DESKTOP_VERSION_CODE"
if [[ "$DESKTOP_PLATFORM" == darwin/universal ]]; then
  app="build/bin/红果短剧.app"
  cp build/sidecar/hongguo-tv-core "$app/Contents/MacOS/"
  mkdir -p "$app/Contents/Resources/zh-Hans.lproj"
  cp resources/zh-Hans.lproj/InfoPlist.strings "$app/Contents/Resources/zh-Hans.lproj/InfoPlist.strings"
  python3 ../scripts/verify_desktop_ui.py "$app/Contents/MacOS/hongguo-tv-core"
  chmod +x "$app/Contents/MacOS/hongguo-tv-core"
  lipo "$app/Contents/MacOS/hongguo-tv-core" -verify_arch x86_64 arm64
  lipo "$app/Contents/MacOS/红果短剧" -verify_arch x86_64 arm64
  # Ad hoc signing verifies bundle integrity; it is not Apple notarization.
  codesign --force --sign - "$app/Contents/MacOS/hongguo-tv-core"
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict "$app"
  # ditto writes UTF-8 Chinese names without the UTF-8 flag on some runners,
  # which other ZIP readers interpret as CP437. Use standard UTF-8 ZIP paths.
  python3 ../scripts/package_desktop_app.py "$app" "dist/hongguo-desktop-$APP_VERSION-macos-universal.zip"
else
  cp build/sidecar/hongguo-tv-core.exe build/bin/
  python3 ../scripts/verify_desktop_ui.py build/bin/hongguo-tv-core.exe
  cp ../docs/desktop-install-windows.txt build/bin/README.txt
  test -s wasm-runtime/decoder.wasm
  test -s wasm-runtime/lgpl-relink.tar.gz
  mkdir -p build/bin/Licenses/FFmpeg
  cp wasm-runtime/FFmpeg-LICENSE.txt wasm-runtime/NOTICE.txt wasm-runtime/lgpl-relink.tar.gz build/bin/Licenses/FFmpeg/
  (cd build/bin && 7z a "../../dist/hongguo-desktop-$APP_VERSION-windows-x64.zip" 红果短剧.exe hongguo-tv-core.exe README.txt Licenses)
fi
python3 - <<'PY'
import hashlib
from pathlib import Path
for path in Path('dist').glob('*.zip'):
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    (path.parent/(path.name+'.sha256')).write_text(digest+'  '+path.name+'\n')
    print(path.name,path.stat().st_size,digest)
PY
