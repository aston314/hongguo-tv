#!/usr/bin/env python3
"""Build the offline s2twp index; --check verifies committed assets without network."""
import argparse
import gzip
import hashlib
import json
import pathlib
import struct

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "third_party/opencc"
OUTPUT = ROOT / "core/cmd/hongguotv/ui/chinese-content"
NAMES = (
    "CJK_Compatibility_Ideographs", "STPhrases",
    "STPhrases_GeneratedFromRegionalPhrases", "STCharacters",
    "TWPhrases", "TWVariantsPhrases", "TWVariants",
)


def build():
    provenance = json.loads((SOURCE / "source.json").read_text())
    hashes = {row["file"]: row["sha256"] for row in provenance["files"]}
    # Header: HGCC, format, total byte length, reserved. All arrays use LE.
    blob = bytearray(16)
    descriptors, pool, pool_ids = {}, [], {}

    def array(fmt, values):
        while len(blob) % 4:
            blob.append(0)
        offset = len(blob)
        blob.extend(struct.pack("<" + fmt * len(values), *values))
        return {"offset": offset, "length": len(values)}

    def units(text):
        raw = text.encode("utf-16-le")
        return struct.unpack("<" + "H" * (len(raw) // 2), raw)

    for name in NAMES:
        filename = name + ".txt.gz"
        raw = gzip.decompress((SOURCE / filename).read_bytes())
        if hashlib.sha256(raw).hexdigest() != hashes[filename]:
            raise ValueError("OpenCC source checksum mismatch: " + name)
        tree, count = {}, 0
        for line in raw.decode("utf-8").splitlines():
            if not line or line.startswith("#"):
                continue
            key, candidates = line.split("\t", 1)
            value, node = candidates.split(" ")[0], tree
            for char in units(key):
                node = node.setdefault(char, {})
            if value not in pool_ids:
                pool_ids[value] = len(pool)
                pool.append(value)
            node[None] = pool_ids[value] + 1
            count += 1
        nodes, edges, starts, terminal = [tree], [], [], []
        for node in nodes:
            starts.append(len(edges))
            terminal.append(node.get(None, 0))
            for char in sorted(key for key in node if key is not None):
                edges.append(char)
                nodes.append(node[char])
        starts.append(len(edges))
        assert len(edges) == len(nodes) - 1
        descriptors[name] = {
            "starts": array("I", starts), "terminal": array("I", terminal),
            "edges": array("H", edges), "nodes": len(nodes), "entries": count,
        }
    offsets, values = [0], []
    for value in pool:
        values.extend(units(value))
        offsets.append(len(values))
    manifest = {
        "format": 1, "version": provenance["version"], "config": "s2twp",
        "dicts": descriptors, "valueOffsets": array("I", offsets),
        "valueUnits": array("H", values), "endianness": "little",
    }
    struct.pack_into("<4sIII", blob, 0, b"HGCC", 1, len(blob), 0)
    manifest["byteLength"] = len(blob)
    manifest["sha256"] = hashlib.sha256(blob).hexdigest()
    index = (json.dumps(manifest, separators=(",", ":")) + "\n").encode()
    return {"s2twp.bin": bytes(blob), "index.json": index,
            "LICENSE": (SOURCE / "LICENSE").read_bytes(),
            "NOTICE": (SOURCE / "NOTICE").read_bytes()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for name, expected in build().items():
        target = OUTPUT / name
        if args.check:
            if not target.is_file() or target.read_bytes() != expected:
                raise SystemExit("Chinese content asset is stale: " + str(target))
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(expected)
    print("Chinese content dictionary: " + ("verified" if args.check else "generated"))


if __name__ == "__main__":
    main()
