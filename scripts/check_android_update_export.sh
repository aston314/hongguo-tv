#!/usr/bin/env bash
set -euo pipefail

api_level="${1:?API level required}"
package=rocks.aston.hongguotv.debug
runner="$package.test/rocks.aston.hongguotv.UpdateApkSaverInstrumentation"
evidence="$(mktemp -d)"
trap 'rm -rf "$evidence"' EXIT

adb install android/app/build/outputs/apk/standard/debug/app-standard-debug.apk
adb install android/app/build/outputs/apk/androidTest/standard/debug/app-standard-debug-androidTest.apk
if [[ "$api_level" == 23 ]]; then
  adb shell am instrument -w -e mode denied "$runner" | tee "$evidence/denied.log"
  grep -q 'UPDATE_EXPORT_OK sdk=23 mode=denied' "$evidence/denied.log"
  # The Android 6 storage group includes read as well as write access.
  adb shell pm grant "$package" android.permission.READ_EXTERNAL_STORAGE
  adb shell pm grant "$package" android.permission.WRITE_EXTERNAL_STORAGE
  adb shell am force-stop "$package"
fi
adb shell am instrument -w -e mode save "$runner" | tee "$evidence/save.log"
grep -q "UPDATE_EXPORT_OK sdk=$api_level mode=save" "$evidence/save.log"
