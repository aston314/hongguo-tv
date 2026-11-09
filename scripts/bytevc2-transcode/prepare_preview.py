#!/usr/bin/env python3
"""Stage an isolated standard-player transcoding APK in the CI checkout only."""
import hashlib
import os
from pathlib import Path
import shutil
import sys


def replace(root, name, old, new, count=1):
    file = root / name
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError("Experiment context changed: " + name)
    file.write_text(text.replace(old, new))


def stage(root):
    here = Path(__file__).resolve().parent
    replace(root, "android/app/build.gradle", 'abiFilters "arm64-v8a", "armeabi-v7a", "x86_64"', 'abiFilters "arm64-v8a"')
    replace(root, "android/app/build.gradle", 'standard {\n            dimension "player"',
            'standard {\n            dimension "player"\n            applicationIdSuffix ".transcodetest"')
    replace(root, "android/app/build.gradle", 'android5Compat ? "红果短剧 · Android 5 兼容版" : "红果短剧"',
            'android5Compat ? "红果短剧 · Android 5 兼容版" : "红果短剧 · 转码测试"', count=2)
    replace(root, "android/app/build.gradle", 'android5Compat ? "hongguo-android5-test" : "hongguo"',
            'android5Compat ? "hongguo-android5-test" : "hongguo-transcode-test"')
    replace(root, "android/app/src/main/java/rocks/aston/hongguotv/CoreService.java",
            'environment.put("MINIREEL_CACHE_DIR", playbackCache.getAbsolutePath());',
            'environment.put("MINIREEL_CACHE_DIR", playbackCache.getAbsolutePath());\n'
            '            environment.put("BVC2_REFERENCE", new File(getApplicationInfo().nativeLibraryDir, "libbvc2reference.so").getAbsolutePath());\n'
            '            environment.put("BVC2_OPTIMIZED", new File(getApplicationInfo().nativeLibraryDir, "libbvc2optimized.so").getAbsolutePath());')
    replace(root, "android/app/src/main/java/rocks/aston/hongguotv/MainActivity.java",
            'webView.loadUrl(coreUrl);', 'webView.loadUrl(coreUrl + "bytevc2-experiment.html");')
    replace(root, "core/cmd/hongguotv/main.go", 'mux := http.NewServeMux()',
            'mux := http.NewServeMux()\n\tregisterBytevc2Experiment(mux)')
    replace(root, "core/cmd/hongguotv/main.go", 'mux.HandleFunc("/minireel-proxy/media/", handleMiniReelMedia)',
            'mux.HandleFunc("/minireel-proxy/media/", handleBytevc2ExperimentMedia)')
    replace(root, "core/cmd/hongguotv/minireel.go", 'case "software", "mpv_software":',
            'case "bytevc2":\n\t\treturn "bytevc2", nil\n\tcase "software", "mpv_software":')
    replace(root, "core/cmd/hongguotv/minireel.go", 'if strings.EqualFold(codec, "bytevc2") {\n\t\t\tcontinue\n\t\t}',
            'if strings.EqualFold(codec, "bytevc2") != (codecMode == "bytevc2") {\n\t\t\tcontinue\n\t\t}')
    shutil.copy(here / "preview.go.txt", root / "core/cmd/hongguotv/bytevc2_experiment_linux.go")
    shutil.copy(here / "preview.html", root / "core/cmd/hongguotv/ui/bytevc2-experiment.html")


if __name__ == "__main__":
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Build/stage Android experiments in GitHub Actions only")
    root = Path(__file__).resolve().parents[2]
    if "--native-only" not in sys.argv:
        stage(root)
    destination = root / "android/app/src/main/jniLibs/arm64-v8a"
    destination.mkdir(parents=True, exist_ok=True)
    for variant in ("reference", "optimized"):
        artifact = Path(os.environ["RUNNER_TEMP"]) / ("bytevc2-transcode-" + variant)
        for line in (artifact / "SHA256SUMS.txt").read_text().splitlines():
            digest, name = line.split(maxsplit=1)
            assert hashlib.sha256((artifact / name).read_bytes()).hexdigest() == digest, name
        shutil.copy(artifact / "bin/ffmpeg", destination / ("libbvc2" + variant + ".so"))
    print("Staged isolated rocks.aston.hongguotv.transcodetest.debug; stable channels disabled by DEBUG")
