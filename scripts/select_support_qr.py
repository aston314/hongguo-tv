#!/usr/bin/env python3
"""Select the bundled donation QR set, or verify that it matches its archive."""

import argparse
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "assets/support-qr"
ACTIVE = ARCHIVE / "active.txt"
DESTINATION = ROOT / "core/cmd/hongguotv/ui/images"
FILES = ("support-wechat.png", "support-alipay.png")
SETS = {"free-v1": "自由金额版", "fixed20-v1": "固定 20 元版"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variant", nargs="?", choices=SETS)
    parser.add_argument("--check", action="store_true", help="verify without changing files")
    args = parser.parse_args()
    if args.variant and args.check:
        parser.error("--check reads the active set; do not pass a variant")
    if not args.variant and not args.check:
        parser.error("choose a variant, or pass --check")
    variant = args.variant or ACTIVE.read_text(encoding="utf-8").strip()
    if variant not in SETS:
        parser.error("unknown active QR set")
    # Read and validate both sources before replacing either active asset.
    sources = [(name, ARCHIVE / variant / name) for name in FILES]
    for name, source in sources:
        if source.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
            parser.error(f"invalid archived PNG: {name}")
    if args.check:
        for name, source in sources:
            if source.read_bytes() != (DESTINATION / name).read_bytes():
                parser.error(f"bundled QR differs from {variant}: {name}")
        print(f"Donation QR verified: {variant} ({SETS[variant]})")
        return
    for name, source in sources:
        shutil.copyfile(source, DESTINATION / name)
    ACTIVE.write_text(variant + "\n", encoding="utf-8")
    print(f"Donation QR selected: {variant} ({SETS[variant]})")


if __name__ == "__main__":
    main()
