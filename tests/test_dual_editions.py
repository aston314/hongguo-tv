import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value

pub = module('publish_public_release')
gen = module('generate_update')
replace = module('replace_mpv_library')

class DualEditionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.notes = self.root / 'notes.md'; self.notes.write_text('双版本')

    def bundle(self):
        manifests = {}
        binaries = []
        source = self.root / 'hongguo-tv-mpv-library-source-0.2.47.zip'
        source.write_bytes(b'source fixture')
        for edition, code, channel in [('standard', 49, 'update.json'), ('mpv', 1, 'update-mpv.json')]:
            apk = self.root / ('hongguo-tv-' + ('mpv-' if edition == 'mpv' else '') + '0.2.47.apk')
            with zipfile.ZipFile(apk, 'w') as archive: archive.writestr('AndroidManifest.xml', edition)
            manifest = gen.generate(apk, '0.2.47', code, 23, self.notes, edition, source if edition == 'mpv' else None)
            manifests[channel] = manifest
            (self.root / channel).write_text(json.dumps(manifest))
            binaries.append(apk)
        binaries.append(source)
        (self.root / 'SHA256SUMS.txt').write_text(''.join(pub.digest(p) + '  ' + p.name + '\n' for p in binaries))
        return manifests

    def test_dual_bundle_only_allows_expected_files(self):
        self.bundle(); (self.root / 'private-account.go').write_text('private')
        with patch.object(pub, 'verify_library_kit'):
            manifests, files = pub.verify_bundle(self.root)
        self.assertEqual(set(manifests), {'update.json', 'update-mpv.json'})
        self.assertEqual(len(files), 6)
        self.assertNotIn('private-account.go', [p.name for p in files])

    def test_public_bundle_can_omit_the_private_mpv_source_kit(self):
        values = self.bundle()
        source = self.root / 'hongguo-tv-mpv-library-source-0.2.47.zip'
        source.unlink()
        values['update-mpv.json'].pop('library_source')
        (self.root / 'update-mpv.json').write_text(json.dumps(values['update-mpv.json']))
        binaries = [self.root / 'hongguo-tv-0.2.47.apk', self.root / 'hongguo-tv-mpv-0.2.47.apk']
        (self.root / 'SHA256SUMS.txt').write_text(''.join(pub.digest(p) + '  ' + p.name + '\n' for p in binaries))
        manifests, files = pub.verify_bundle(self.root)
        self.assertEqual(set(manifests), {'update.json', 'update-mpv.json'})
        self.assertEqual({p.name for p in files}, {'hongguo-tv-0.2.47.apk', 'hongguo-tv-mpv-0.2.47.apk', 'SHA256SUMS.txt', 'update.json', 'update-mpv.json'})

    def test_cross_edition_manifest_is_rejected(self):
        values = self.bundle(); values['update-mpv.json']['package_name'] = 'rocks.aston.hongguotv'
        (self.root / 'update-mpv.json').write_text(json.dumps(values['update-mpv.json']))
        with patch.object(pub, 'verify_library_kit'), self.assertRaises(ValueError): pub.verify_bundle(self.root)

    def test_corrupt_library_attachment_is_rejected(self):
        self.bundle(); (self.root / 'hongguo-tv-mpv-library-source-0.2.47.zip').write_bytes(b'corrupt')
        with self.assertRaises(ValueError): pub.verify_bundle(self.root)

    def test_duplicate_checksum_is_rejected(self):
        self.bundle(); path = self.root / 'SHA256SUMS.txt'; path.write_text(path.read_text() * 2)
        with patch.object(pub, 'verify_library_kit'), self.assertRaises(ValueError): pub.verify_bundle(self.root)

    def test_both_channels_publish_and_rerun_is_idempotent(self):
        values = self.bundle(); channels = {}; release = {'id': 3, 'draft': True, 'assets': []}; mutations = []
        def read(channel):
            data = channels.get(channel)
            return (None, None) if data is None else ({'sha': channel, 'content': base64.b64encode(data).decode()}, json.loads(data))
        def api(endpoint, **kwargs):
            if endpoint == 'repos/' + pub.REPOSITORY: return {'private': False, 'default_branch': 'main'}
            if kwargs.get('payload', {}).get('draft') is False: release['draft'] = False; mutations.append('publish')
            return release.copy()
        def upload(identity, path):
            asset = {'name': path.name, 'size': path.stat().st_size, 'digest': 'sha256:' + pub.digest(path)}
            release['assets'].append(asset); mutations.append('upload'); return asset
        def gh(*args, payload=None):
            channel = args[-1].rsplit('/', 1)[-1]
            channels[channel] = base64.b64decode(payload['content']); mutations.append(channel)
        with patch.object(pub, 'verify_library_kit'), patch.object(pub, 'read_channel', read), patch.object(pub, 'api', api), patch.object(pub, 'upload_asset', upload), patch.object(pub, 'gh', gh), patch.object(pub, 'release_by_tag', side_effect=lambda tag: release):
            pub.publish(self.root, self.notes)
            self.assertEqual(set(channels), set(values))
            self.assertEqual(len(release['assets']), 6)
            count = len(mutations); pub.publish(self.root, self.notes)
            self.assertEqual(len(mutations), count)

    def test_changed_bytes_same_code_fails_before_any_mutation(self):
        values = self.bundle(); previous = dict(values['update-mpv.json'], sha256='0'*64)
        def read(channel): return None, previous if channel == 'update-mpv.json' else None
        with patch.object(pub, 'verify_library_kit'), patch.object(pub, 'read_channel', read), patch.object(pub, 'api', return_value={'private': False, 'default_branch': 'main'}), patch.object(pub, 'release_by_tag') as lookup, self.assertRaises(ValueError):
            pub.publish(self.root, self.notes)
        lookup.assert_not_called()

    def test_older_channel_never_regresses_and_matching_code_is_immutable(self):
        self.assertFalse(pub.may_update({'version_code': 50}, {'version_code': 49}))
        self.assertTrue(pub.may_update({'version_code': 1, 'sha256': 'a'}, {'version_code': 1, 'sha256': 'a'}))
        with self.assertRaises(ValueError): pub.may_update({'version_code': 1, 'sha256': 'a'}, {'version_code': 1, 'sha256': 'b'})

    def test_permission_network_error_does_not_mean_missing_channel(self):
        with patch.object(pub, 'gh', return_value=SimpleNamespace(returncode=1, stderr='HTTP 403', stdout='')), self.assertRaises(RuntimeError): pub.read_channel('update-mpv.json')

    def kit(self, extra=False, corrupt=False):
        data = b'source'; pins = {'mpv': {'sha256': hashlib.sha256(data).hexdigest()}}
        names = ['android/mpv-jni/bridge.cpp', 'android/mpv-jni/media_codec_layout_parser.h', 'android/mpv-jni/LICENSE', 'android/app/src/mpv/java/rocks/aston/hongguotv/MPVLib.java', 'scripts/prepare_mpv.py', 'scripts/mpv_sources.json', 'scripts/replace_mpv_library.py', 'scripts/rebuild_mpv_libraries.py', 'docs/mpv-library-source.md', 'android/mpv-jni/include/mpv/client.h', 'BINARY-PINS.json', 'NOTICE.txt', 'sources/mpv.tar.gz']
        entries = {name: b'fixture' for name in names}
        entries['scripts/mpv_sources.json'] = json.dumps(pins).encode(); entries['sources/mpv.tar.gz'] = data
        if extra: entries['private-app.go'] = b'private'
        entries['KIT-SHA256SUMS.txt'] = ''.join(hashlib.sha256(value).hexdigest() + '  ' + name + '\n' for name, value in entries.items()).encode()
        if corrupt: entries['sources/mpv.tar.gz'] = b'changed'
        path = self.root / 'kit.zip'
        with zipfile.ZipFile(path, 'w') as kit:
            for name, value in entries.items(): kit.writestr(name, value)
        return path, pins

    def test_library_kit_rejects_private_source_and_corruption(self):
        path, pins = self.kit(); pub.verify_library_kit(path, pins)
        for extra, corrupt in [(True,False), (False,True)]:
            path, pins = self.kit(extra, corrupt)
            with self.assertRaises(ValueError): pub.verify_library_kit(path, pins)

    def replacement_files(self):
        apk = self.root / 'original.apk'; libs = self.root / 'libs'
        with zipfile.ZipFile(apk, 'w') as z:
            z.writestr('META-INF/CERT.RSA', b'old'); z.writestr('AndroidManifest.xml', b'manifest')
            for abi, cls, machine in [('arm64-v8a',2,183),('armeabi-v7a',1,40),('x86_64',2,62)]:
                data = bytearray(64); data[:6]=b'\x7fELF'+bytes([cls,1]); data[18:20]=machine.to_bytes(2,'little')
                folder = libs / abi; folder.mkdir(parents=True); (folder / 'libmpv.so').write_bytes(data)
                z.writestr('lib/'+abi+'/libmpv.so', b'old-library')
        return apk, libs

    def test_library_replacement_preserves_app_strips_signature_and_matches_abi(self):
        apk, libs = self.replacement_files(); output = self.root / 'modified.apk'
        replace.replace(apk, libs, output)
        with zipfile.ZipFile(output) as z:
            self.assertNotIn('META-INF/CERT.RSA', z.namelist()); self.assertEqual(z.read('AndroidManifest.xml'), b'manifest')
            self.assertEqual(z.read('lib/arm64-v8a/libmpv.so'), (libs/'arm64-v8a/libmpv.so').read_bytes())
        with self.assertRaises(ValueError): replace.replace(apk, libs, output)

    def test_wrong_abi_fails_without_output(self):
        apk, libs = self.replacement_files(); output = self.root / 'modified.apk'
        (libs/'arm64-v8a/libmpv.so').write_bytes((libs/'armeabi-v7a/libmpv.so').read_bytes())
        with self.assertRaises(ValueError): replace.replace(apk, libs, output)
        self.assertFalse(output.exists())

if __name__ == '__main__': unittest.main()
