#!/usr/bin/env python3
"""Opt-in sample capture via a temporary Go overlay, never editing app code."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video-id", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not args.video_id.isdecimal():
        parser.error("video-id must be numeric")
    root = Path(__file__).resolve().parents[2]
    source = root / "core/cmd/hongguotv/minireel.go"
    original = source.read_bytes()
    text = original.decode()
    needle = 'if strings.EqualFold(codec, "bytevc2") {\n\t\t\tcontinue\n\t\t}'
    if text.count(needle) != 1:
        raise RuntimeError("Production filter changed; review the experiment overlay")
    args.out.mkdir(parents=True, exist_ok=True)
    args.out.chmod(0o700)
    with tempfile.TemporaryDirectory(prefix="hongguo-bvc2-capture-") as temp:
        temp = Path(temp)
        modified = temp / "minireel.go"
        modified.write_text(text.replace(needle, needle.replace("if strings", "if !strings")))
        probe = temp / "capture_test.go"
        probe.write_bytes((Path(__file__).parent / "capture_probe.go.txt").read_bytes())
        overlay = temp / "overlay.json"
        overlay.write_text(json.dumps({"Replace": {
            str(source): str(modified),
            str(source.parent / "bytevc2_experiment_test.go"): str(probe),
        }}))
        env = {**os.environ, "BYTEVC2_SAMPLE_DIR": str(args.out.resolve()),
               "BYTEVC2_VIDEO_ID": args.video_id}
        result = subprocess.run(["go", "test", "-overlay", str(overlay),
                                 "./core/cmd/hongguotv", "-run", "^TestByteVC2Capture$",
                                 "-count=1", "-v"], cwd=root, env=env, timeout=150)
        if source.read_bytes() != original:
            raise RuntimeError("Production source unexpectedly changed")
        result.check_returncode()
    print("Production source SHA256 unchanged:", hashlib.sha256(original).hexdigest())


if __name__ == "__main__":
    main()
