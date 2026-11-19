import hashlib
import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import publish_playback_resolver as publisher


class PlaybackResolverPublishTests(unittest.TestCase):
    def test_manifest_matches_artifact_and_release_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / 'resolver.wasm'
            contents = b'wasm fixture'
            artifact.write_bytes(contents)
            manifest = root / 'playback-resolver.json'
            manifest.write_text(json.dumps({
                'schema': 1,
                'product': 'hongguo-playback-resolver',
                'resolver_version': '2026.11.19.1',
                'protocol': 1,
                'size': len(contents),
                'sha256': hashlib.sha256(contents).hexdigest(),
                'download_url': 'https://github.com/aston314/hongguo-tv-releases/releases/download/playback-resolver-v2026.11.19.1/resolver.wasm',
                'signature': base64.b64encode(b'x' * 64).decode(),
            }))
            result = publisher.read_manifest(manifest, artifact)
            self.assertEqual(result['resolver_version'], '2026.11.19.1')

    def test_manifest_rejects_wrong_artifact_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / 'resolver.wasm'
            artifact.write_bytes(b'x')
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({
                'schema': 1, 'product': 'hongguo-playback-resolver', 'resolver_version': '1.2.3',
                'protocol': 1, 'size': 1, 'sha256': hashlib.sha256(b'x').hexdigest(),
                'download_url': 'https://example.com/resolver.wasm',
                'signature': base64.b64encode(b'x' * 64).decode(),
            }))
            with self.assertRaises(ValueError):
                publisher.read_manifest(manifest, artifact)

    def test_manifest_rejects_malformed_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / 'resolver.wasm'
            artifact.write_bytes(b'x')
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({
                'schema': 1, 'product': 'hongguo-playback-resolver', 'resolver_version': '1.2.3',
                'protocol': 1, 'size': 1, 'sha256': hashlib.sha256(b'x').hexdigest(),
                'download_url': 'https://github.com/aston314/hongguo-tv-releases/releases/download/playback-resolver-v1.2.3/resolver.wasm',
                'signature': 'not-base64',
            }))
            with self.assertRaises(ValueError):
                publisher.read_manifest(manifest, artifact)


if __name__ == '__main__':
    unittest.main()
