#!/usr/bin/env python3
"""Verify the app and JavaScript Service entry points inside a webOS IPK."""

import json
import re
import sys
import tarfile
from io import BytesIO
from pathlib import Path


def fail(message):
    raise SystemExit("webOS IPK verify: " + message)


def ar_members(path):
    raw = Path(path).read_bytes()
    if not raw.startswith(b"!<arch>\n"):
        fail("not an ar/IPK archive")
    offset = 8
    members = {}
    while offset < len(raw):
        header = raw[offset : offset + 60]
        if len(header) != 60 or header[58:60] != b"`\n":
            fail("invalid ar member header")
        name = header[:16].decode("ascii").strip().rstrip("/")
        try:
            size = int(header[48:58].decode("ascii").strip())
        except ValueError:
            fail("invalid ar member size")
        offset += 60
        members[name] = raw[offset : offset + size]
        offset += size + (size & 1)
    return members


def read_tar_member(archive, suffix):
    with tarfile.open(fileobj=BytesIO(archive), mode="r:gz") as package:
        matches = [member for member in package.getmembers() if member.name.endswith(suffix)]
        if len(matches) != 1:
            fail("expected exactly one " + suffix + " in package")
        stream = package.extractfile(matches[0])
        if stream is None:
            fail("could not read " + suffix)
        return stream.read(), package, matches[0].name


def main():
    staging = len(sys.argv) == 3 and sys.argv[1] == "--staging"
    package_arg = sys.argv[2] if staging else sys.argv[1] if len(sys.argv) == 2 else None
    if package_arg is None:
        fail("usage: verify_webos_ipk.py [--staging] path/to/app.ipk")
    members = ar_members(package_arg)
    if "data.tar.gz" not in members:
        fail("IPK has no data.tar.gz")
    appinfo_raw, _, appinfo_path = read_tar_member(members["data.tar.gz"], "/appinfo.json")
    packageinfo_raw, _, packageinfo_path = read_tar_member(members["data.tar.gz"], "/packageinfo.json")
    appinfo = json.loads(appinfo_raw)
    app_id = appinfo.get("id", "")
    if staging:
        suffix = app_id[len("com.aston314.hongguo.webos") :] if app_id.startswith("com.aston314.hongguo.webos") else ""
        if re.fullmatch(r"\.[a-z0-9-]{1,24}", suffix) is None:
            fail("staging app id must use an isolated suffix")
        expected_service_id = app_id + ".service"
    else:
        if app_id != "com.aston314.hongguo.webos":
            fail("unexpected app id")
        expected_service_id = "com.aston314.hongguo.webos.service"
    service_package_raw, _, service_package_path = read_tar_member(members["data.tar.gz"], "/services/" + expected_service_id + "/package.json")
    services_raw, _, services_path = read_tar_member(members["data.tar.gz"], "/services/" + expected_service_id + "/services.json")
    packageinfo = json.loads(packageinfo_raw)
    service_package = json.loads(service_package_raw)
    services_manifest = json.loads(services_raw)
    if service_package.get("name") != expected_service_id:
        fail("service package id mismatch")
    if service_package.get("main") != "service-entry.js":
        fail("service package main must be the bootstrap entry service-entry.js")
    if service_package.get("version") != appinfo.get("version"):
        fail("service package version must match app version")
    service_definitions = services_manifest.get("services", [])
    service_definition = next((entry for entry in service_definitions if entry.get("name") == expected_service_id), None)
    if service_definition is None:
        fail("services.json does not define the app service")
    commands = {entry.get("name"): entry for entry in service_definition.get("commands", [])}
    for command in ("ping", "getDiagnostics", "shutdown"):
        if command not in commands or commands[command].get("public") is not True:
            fail("services.json command must be declared public: " + command)
    service_root = service_package_path.rsplit("/", 1)[0]
    service_path = service_root + "/service-entry.js"
    app_root = appinfo_path.rsplit("/", 1)[0]
    names = set()
    with tarfile.open(fileobj=BytesIO(members["data.tar.gz"]), mode="r:gz") as package:
        names = {entry.name for entry in package.getmembers()}
        app_index_path = app_root + "/" + appinfo.get("main", "")
        if app_index_path not in names:
            fail("app main file is missing from package")
        if service_path not in names:
            fail("service main file is missing from package")
        if service_root + "/service.js" not in names:
            fail("service factory is missing from package")
        if service_root + "/media-cache.js" not in names:
            fail("media cache policy is missing from package")
        for name in ("updates.js", "update-manifest.js"):
            if service_root + "/" + name not in names:
                fail("webOS update checker is missing from package")
        for name in ("playback-repair.js", "playback-rule-runtime.js", "playback-rule-worker.js",
                     "playback-rule-network.js", "playback-rule-verifier.js", "playback-rule-trust.js",
                     "vendor/tweetnacl/nacl-fast.js", "vendor/tweetnacl/LICENSE",
                     "vendor/bytes/browser-buffer.js", "vendor/bytes/browser-buffer.LICENSE",
                     "vendor/bytes/base64-js.js", "vendor/bytes/base64-js.LICENSE",
                     "vendor/bytes/ieee754.js", "vendor/bytes/ieee754.LICENSE"):
            if service_root + "/" + name not in names:
                fail("signed playback rule host asset is missing: " + name)
        if any(name.endswith(".test.js") for name in names):
            fail("test harness files must not be packaged")
        entry_stream = package.extractfile(service_path)
        if not entry_stream or not re.search(r"require\(\s*['\"]\./service['\"]\s*\)\s*\(\s*\)", entry_stream.read().decode("utf-8")):
            fail("service bootstrap entry does not initialize the factory")
        index_stream = package.extractfile(app_index_path)
        if index_stream is None:
            fail("could not read packaged app main")
        index = index_stream.read().decode("utf-8")
        adapter = app_root + "/webos-adapter.js"
        if adapter not in names:
            fail("webOS adapter is missing from package")
        for name in ("webos-updates.js", "webos-update-manifest.js"):
            if app_root + "/" + name not in names or index.find(name) < 0 or index.find(name) > index.find('src="./webos-adapter.js"'):
                fail("webOS update bridge must load before adapter")
        webos_tv = app_root + "/webOSTVjs-1.2.13/webOSTV.js"
        if webos_tv not in names:
            fail("official webOSTV.js library is missing from package")
        webos_tv_license = app_root + "/webOSTVjs-1.2.13/LICENSE-2.0.txt"
        if webos_tv_license not in names:
            fail("webOSTV.js license is missing from package")
        if index.find('src="./webOSTVjs-1.2.13/webOSTV.js"') < 0 or index.find('src="./webos-adapter.js"') < 0 or index.find('src="./webOSTVjs-1.2.13/webOSTV.js"') > index.find('src="./webos-adapter.js"') or index.find('src="./webos-adapter.js"') > index.find('src="./compat.js"'):
            fail("webOSTV.js and webOS adapter must load before shared UI scripts")
        adapter_stream = package.extractfile(adapter)
        if adapter_stream is None:
            fail("could not read packaged webOS adapter")
        adapter = adapter_stream.read().decode("utf-8")
        if "getDiagnostic" not in adapter or "/api/v1/health" not in adapter or "HEALTH_NOT_READY" not in adapter:
            fail("packaged adapter must verify HTTP readiness and expose diagnostics")
        version_pattern = r"appVersion\s*:\s*['\"]" + re.escape(str(appinfo.get("version", ""))) + r"['\"]"
        if re.search(version_pattern, adapter) is None:
            fail("packaged adapter app version must match appinfo.json")
        if 'id="core-connection-modal"' not in index or 'id="core-connection-retry"' not in index or 'id="core-connection-close"' not in index:
            fail("packaged UI must include the connection diagnostic modal and actions")
        if staging:
            manifest_path = app_root + "/webos-stage-manifest.json"
            if manifest_path not in names:
                fail("staging manifest is missing")
            manifest_stream = package.extractfile(manifest_path)
            manifest = json.loads(manifest_stream.read().decode("utf-8")) if manifest_stream else {}
            mode = manifest.get("connection_mode")
            expected_base = "http://127.0.0.1:7655" if mode == "luna" else manifest.get("service_base", "")
            if mode not in ("luna", "http-direct") or manifest.get("staging_only") is not True:
                fail("staging manifest is invalid")
            if manifest.get("app_id") != app_id or manifest.get("service_id") != expected_service_id:
                fail("staging manifest identity mismatch")
            report_url = manifest.get("report_url", "")
            if report_url:
                report_config = app_root + "/webos-simulator-config.js"
                if report_config not in names:
                    fail("staging report URL config is missing")
                report_stream = package.extractfile(report_config)
                if not report_stream or report_url not in report_stream.read().decode("utf-8"):
                    fail("staging report URL does not match its manifest")
                if "webos-simulator-config.js" not in index or index.find("webos-simulator-config.js") > index.find("webos-simulator-probe.js"):
                    fail("staging report config must load before the playback probe")
            if expected_base not in adapter:
                fail("staging adapter mode or base does not match its manifest")
            if mode == "http-direct" and not re.fullmatch(r"http://(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)[0-9.]+:\d{1,5}", expected_base):
                fail("HTTP staging base must be a private IPv4 address")
            if mode == "http-direct" and ("http-direct" not in adapter or "Luna Service 未验证" not in adapter):
                fail("HTTP staging mode must identify itself and state that Luna is unverified")
            if mode == "luna" and "Luna ping 与本机 HTTP 健康检查均成功" not in adapter:
                fail("Luna staging adapter is missing its Luna readiness diagnostic")
        elif app_root + "/webos-stage-manifest.json" in names or "192.168.2.124" in adapter:
            fail("staging configuration leaked into the production package")
    services = packageinfo.get("services", [])
    if expected_service_id not in services:
        fail("package does not register the HTTP service")
    print("webOS IPK verify: PASS")
    print(json.dumps({"appId": app_id, "version": appinfo["version"], "serviceId": expected_service_id, "staging": staging, "serviceMain": service_package["main"], "serviceCommands": sorted(commands), "members": len(names)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
