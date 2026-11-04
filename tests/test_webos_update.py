import base64
from io import BytesIO
import hashlib
import json
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import publish_webos_update as channel


class WebOSUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ipk = self.root / 'hongguo-webos-0.2.117-test.27.ipk'
        data = BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            content = json.dumps({'id': 'com.aston314.hongguo.webos', 'version': '0.2.117'}).encode()
            info = tarfile.TarInfo('usr/palm/applications/com.aston314.hongguo.webos/appinfo.json')
            info.size = len(content)
            archive.addfile(info, BytesIO(content))
        blob = data.getvalue()
        header = f'{"data.tar.gz/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(blob):<10}`\n'.encode()
        self.ipk.write_bytes(b'!<arch>\n' + header + blob + (b'\n' if len(blob) % 2 else b''))
        self.notes = self.root / 'notes.md'
        self.notes.write_text('更新说明')
        self.value = channel.generate(self.ipk, '0.2.117', self.notes)

    def fixture(self, old=None, draft=False, corrupt=False, missing=False):
        writes = []
        release = {'draft': draft, 'assets': [] if missing else [{'name': self.ipk.name, 'size': self.ipk.stat().st_size,
            'digest': 'sha256:' + ('0' * 64 if corrupt else hashlib.sha256(self.ipk.read_bytes()).hexdigest())}]}
        old_api, old_gh = channel.api, channel.gh
        channel.api = lambda path: release
        def gh(*args, **kwargs):
            if args[:2] == ('api', f'repos/{channel.REPOSITORY}/contents/webos-update.json'):
                if old is None:
                    return SimpleNamespace(returncode=1, stderr='HTTP 404')
                return SimpleNamespace(returncode=0, stdout=json.dumps({'sha': 'previous', 'content': base64.b64encode(json.dumps(old).encode()).decode()}))
            self.assertEqual(args, ('api', '--method', 'PUT', f'repos/{channel.REPOSITORY}/contents/webos-update.json'))
            writes.append(kwargs['payload'])
            return SimpleNamespace(returncode=0, stdout='{}')
        channel.gh = gh
        self.addCleanup(setattr, channel, 'api', old_api)
        self.addCleanup(setattr, channel, 'gh', old_gh)
        return writes

    def test_manifest_only_points_to_the_matching_webos_release(self):
        self.assertEqual(self.value['platform'], 'webos')
        self.assertEqual(self.value['artifact_sha256'], hashlib.sha256(self.ipk.read_bytes()).hexdigest())
        self.assertEqual(self.value['release_url'], 'https://github.com/aston314/hongguo-tv-releases/releases/tag/webos-v0.2.117-test.27')
        self.assertNotIn('download_url', self.value)
        with self.assertRaises(ValueError):
            channel.generate(self.ipk, '0.2.118', self.notes)

    def test_no_channel_before_exact_ipk_is_public(self):
        for options in [{'draft': True}, {'corrupt': True}, {'missing': True}]:
            with self.subTest(options=options):
                writes = self.fixture(**options)
                with self.assertRaises(ValueError):
                    channel.publish(self.value)
                self.assertEqual(writes, [])

    def test_only_updates_the_webos_channel(self):
        writes = self.fixture()
        channel.publish(self.value)
        self.assertEqual(len(writes), 1)
        self.assertEqual(json.loads(base64.b64decode(writes[0]['content'])), self.value)

    def test_semantic_monotonicity_and_same_version_byte_protection(self):
        newer = dict(self.value, version_name='0.2.118')
        writes = self.fixture(old=newer)
        channel.publish(self.value)
        self.assertEqual(writes, [])
        writes = self.fixture(old=dict(self.value, artifact_sha256='b' * 64))
        with self.assertRaises(ValueError):
            channel.publish(self.value)
        self.assertEqual(writes, [])


if __name__ == '__main__':
    unittest.main()
