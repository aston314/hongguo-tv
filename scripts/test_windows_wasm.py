#!/usr/bin/env python3
"""Exercise the packaged Windows shell using its actual WebView2 and WASM assets."""
import os, pathlib, shutil, subprocess, sys, tempfile, urllib.request, zipfile
root=pathlib.Path(__file__).resolve().parents[1]
app=pathlib.Path(sys.argv[1]).resolve()
out=root/'desktop/dist'; out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hongguo-wasm-check-') as directory:
    work=pathlib.Path(directory)
    archive=work/'ffmpeg.zip'
    # CI fixture generator only; this binary is never shipped in the application.
    urllib.request.urlretrieve('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',archive)
    with zipfile.ZipFile(archive) as z:
        member=next(n for n in z.namelist() if n.endswith('/bin/ffmpeg.exe'))
        ffmpeg=work/'ffmpeg.exe'; ffmpeg.write_bytes(z.read(member))
    for name,codec,size in [('hevc720','libx265','1280x720'),('hevc1080','libx265','1920x1080'),('h264','libx264','1280x720')]:
        command=[str(ffmpeg),'-hide_banner','-loglevel','error','-y','-f','lavfi','-i',f'testsrc2=size={size}:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','10','-c:v',codec,'-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',str(work/(name+'.mp4'))]
        subprocess.run(command,check=True,timeout=180)
    real_media=os.environ.get('HONGGUO_WASM_REAL_MEDIA')
    if real_media:
        for name in ('real720.mp4','real1080.mp4'):
            shutil.copy2(pathlib.Path(real_media)/name,work/name)
    env=os.environ.copy()
    env.update(HONGGUO_WASM_PROBE_OUTPUT=str(out),HONGGUO_WASM_PROBE_MEDIA=str(work),HONGGUO_WASM_PROBE_JS=str(root/'scripts/windows_wasm_probe.js'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--autoplay-policy=no-user-gesture-required')
    process=subprocess.run([str(app/'红果短剧.exe'),'--windows-wasm-self-test'],env=env,timeout=220,capture_output=True,text=True)
    if process.returncode:
        print(process.stdout); print(process.stderr); raise SystemExit(process.returncode)
    print((out/'wasm-validation.json').read_text(encoding='utf-8'))
