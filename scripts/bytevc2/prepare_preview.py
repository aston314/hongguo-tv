#!/usr/bin/env python3
"""Stage a disposable, separately identified ByteVC2 app in GitHub's checkout.

Production files in the development branch remain untouched. Every replacement
is exact and fails closed when its source context changes.
"""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess


def replace(root, relative, old, new, count=1):
    file = root / relative
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError("Experiment patch context changed: " + relative)
    file.write_text(text.replace(old, new))


def stage(root, abi="arm64-v8a"):
    replace(root, "android/app/build.gradle",
            'abiFilters "arm64-v8a", "armeabi-v7a", "x86_64"', 'abiFilters "' + abi + '"')
    replace(root, "android/app/build.gradle", 'applicationIdSuffix ".mpv"',
            'applicationIdSuffix ".mpv.bytevc2test"\n            versionNameSuffix "-bytevc2-test"')
    replace(root, "android/app/build.gradle", 'android5Compat ? "hongguo-android5-test" : "hongguo"',
            'android5Compat ? "hongguo-android5-test" : "hongguo-bytevc2-test"')
    # The shared debug build type supplies the launcher label last.
    replace(root, "android/app/build.gradle", 'android5Compat ? "红果短剧 · Android 5 兼容版" : "红果短剧"',
            'android5Compat ? "红果短剧 · Android 5 兼容版" : "红果短剧 · ByteVC2测试"', count=2)
    file = "core/cmd/hongguotv/minireel.go"
    replace(root, file, 'case "software", "mpv_software":',
            'case "bytevc2":\n\t\treturn "bytevc2", nil\n\tcase "software", "mpv_software":')
    replace(root, file, 'if strings.EqualFold(codec, "bytevc2") {\n\t\t\tcontinue\n\t\t}',
            'if strings.EqualFold(codec, "bytevc2") != (codecMode == "bytevc2") {\n\t\t\tcontinue\n\t\t}')
    # Test-only selection mode defaults to ByteVC2. The original compatible
    # path is available for HEVC/AVC regression comparisons after page reload.
    replace(root, "core/cmd/hongguotv/ui/app.js", '  function playbackCodecMode() {',
            '  function playbackCodecMode() {\n'
            '    try { if (localStorage.getItem("hongguo.bytevc2.test-source") !== "compatible") return "bytevc2"; } catch (ignoredExperiment) { return "bytevc2"; }')
    replace(root, "core/cmd/hongguotv/ui/native-player.js",
            'paused: false, speed: state.playbackRate || 1, diagnostic_id: nativeDiagnosticId',
            'paused: false, speed: state.playbackRate || 1, diagnostic_id: nativeDiagnosticId, video_codec: sourceCodec')
    replace(root, "android/app/src/mpv/java/rocks/aston/hongguotv/MpvPlayerBridge.java",
            'return target.softwareFallback ? "no" : target.mode.hwdec;',
            'return "bytevc2".equals(target.data.optString("video_codec")) || target.softwareFallback ? "no" : target.mode.hwdec;')
    shutil.copy(Path(__file__).parent / "preview_probe.go.txt",
                root / "core/cmd/hongguotv/bytevc2_experiment_test.go")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--stage-only", action="store_true")
    parser.add_argument("--abi", choices=("arm64-v8a", "armeabi-v7a"), default="arm64-v8a")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Experimental Android builds/staging run only in GitHub Actions")
    for line in (args.native / "SHA256SUMS.txt").read_text().splitlines():
        digest, filename = line.split(maxsplit=1)
        if hashlib.sha256((args.native / filename).read_bytes()).hexdigest() != digest:
            raise RuntimeError("Experimental native library checksum mismatch")
    stage(root, args.abi)
    output = root / "android/app/src/mpv/jniLibs"
    if output.exists():
        shutil.rmtree(output)
    destination = output / args.abi
    destination.mkdir(parents=True)
    shutil.copy(args.native / "lib" / args.abi / "libmpv.so", destination)
    header = root / "android/mpv-jni/include"
    if header.exists():
        shutil.rmtree(header)
    shutil.copytree(args.native / "include", header)
    if not args.stage_only:
        toolchain = Path(os.environ["ANDROID_HOME"]) / "ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin"
        subprocess.run([str(toolchain / ("armv7a-linux-androideabi23-clang++" if args.abi == "armeabi-v7a" else "aarch64-linux-android23-clang++")), "-std=c++17", "-O2",
                        "-fPIC", "-shared", "-static-libstdc++", "-Wl,--no-undefined",
                        "-Wl,-z,max-page-size=16384", "-I" + str(header),
                        str(root / "android/mpv-jni/bridge.cpp"), "-L" + str(destination),
                        "-lmpv", "-o", str(destination / "libhongguompv.so")], check=True)
    notices = root / "android/app/src/mpv/assets/mpv-notices.txt"
    notices.parent.mkdir(parents=True, exist_ok=True)
    notices.write_text("ByteVC2 experimental GPL build; MPV 0.41 / FFmpeg 8.1.3.\n"
                       "Complete corresponding app/native source is attached to this temporary test draft.\n"
                       + (args.native / "BUILD.txt").read_text())
    print("Staged isolated MPV ByteVC2 test:", args.abi, "; stable updates disabled by DEBUG")


if __name__ == "__main__":
    main()
