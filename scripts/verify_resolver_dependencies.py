"""Reject accidental application or network-stack dependencies in the guest."""
import os
import subprocess

env = dict(os.environ, GOOS="wasip1", GOARCH="wasm", GOTOOLCHAIN="go1.25.5")
dependencies = subprocess.check_output(
    ["go", "list", "-deps", "./core/cmd/playbackresolver"], env=env, text=True
).splitlines()
guest_packages = {
    "github.com/aston314/hongguo-tv/core/cmd/playbackresolver",
    "github.com/aston314/hongguo-tv/core/internal/playbackresolver",
    "github.com/aston314/hongguo-tv/core/internal/resolverwire",
}
forbidden = [
    name for name in dependencies
    if name == "net/http" or name.startswith("net/http/")
    or name == "crypto/tls"
    or name.startswith("github.com/tetratelabs/wazero")
    or name.startswith("github.com/skip2/go-qrcode")
    or (name.startswith("github.com/aston314/hongguo-tv/")
        and name not in guest_packages)
]
if forbidden:
    raise SystemExit("Resolver guest has forbidden dependencies: " + ", ".join(forbidden))
print("Standalone resolver dependency boundary: OK")
