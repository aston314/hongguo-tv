"""Include licenses for dependencies actually reachable by the diagnostic host."""
import pathlib
import subprocess

modules = sorted(set(subprocess.check_output([
    "go", "list", "-deps", "-tags", "resolverjsprobe", "-f",
    "{{if .Module}}{{.Module.Path}}{{end}}", "./core/cmd/hongguotv"
], text=True).split()))
out = ["Local JS resolver prototype — dependency licenses\n",
       "Protocol ports retain their source attribution; see THIRD_PARTY_NOTICES.md.\n"]
for module in modules:
    if module == "github.com/aston314/hongguo-tv":
        continue
    directory = pathlib.Path(subprocess.check_output(["go", "list", "-m", "-f", "{{.Dir}}", module], text=True).strip())
    licenses = sorted(p for p in directory.iterdir() if p.is_file() and p.name.lower().startswith(("license", "copying", "notice")))
    if not licenses:
        raise SystemExit("Missing dependency license: " + module)
    for license_file in licenses:
        out.extend(["\n=== " + module + "/" + license_file.name + " ===\n", license_file.read_text()])
target = pathlib.Path("android/resolver-js-diagnostic/src/main/assets/DEPENDENCY-LICENSES.txt")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text("\n".join(out))
print("Packaged JS diagnostic dependency licenses")
