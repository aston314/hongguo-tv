import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


gen = module('generate_update')
pub = module('publish_public_release')


class Android5ReleaseTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.notes = self.root / 'notes.md'
        self.notes.write_text('Android 5 兼容包与独立更新')

    def bundle(self):
        binaries = []
        for variant, sdk, code, channel in [('standard', 23, 149, 'update.json'),
                                            ('mpv', 23, 101, 'update-mpv.json'),
                                            ('android5', 21, 149, 'update-android5.json')]:
            prefix = '' if variant == 'standard' else variant + '-'
            apk = self.root / f'hongguo-tv-{prefix}0.2.150.apk'
            with zipfile.ZipFile(apk, 'w') as archive:
                archive.writestr('AndroidManifest.xml', variant)
            value = gen.generate(apk, '0.2.150', code, sdk, self.notes, variant)
            (self.root / channel).write_text(json.dumps(value))
            binaries.append(apk)
        (self.root / 'SHA256SUMS.txt').write_text(''.join(pub.digest(p) + '  ' + p.name + '\n' for p in binaries))

    def test_three_channels_preserve_exact_bytes_when_staging_public_files(self):
        self.bundle()
        target = self.root / 'public'
        pub.stage_public_bundle(self.root, target)
        manifests, files = pub.verify_bundle(target)
        self.assertEqual(set(manifests), {'update.json', 'update-mpv.json', 'update-android5.json'})
        android5 = manifests['update-android5.json']
        self.assertEqual(android5['package_name'], 'rocks.aston.hongguotv.android5test')
        self.assertEqual(android5['min_sdk'], 21)
        self.assertEqual(android5['version_code'], manifests['update.json']['version_code'])
        self.assertEqual(len(files), 7)
        for path in files:
            if path.suffix == '.apk':
                self.assertEqual(path.read_bytes(), (self.root / path.name).read_bytes())

    def test_android5_cannot_weaken_the_existing_channels_or_target_android6(self):
        self.bundle()
        for variant, sdk in [('standard', 21), ('mpv', 21), ('android5', 23), ('android5', 22)]:
            prefix = '' if variant == 'standard' else variant + '-'
            with self.subTest(variant=variant, sdk=sdk), self.assertRaises(ValueError):
                gen.generate(self.root / f'hongguo-tv-{prefix}0.2.150.apk', '0.2.150', 149, sdk, self.notes, variant)
        manifest = self.root / 'update-android5.json'
        value = json.loads(manifest.read_text())
        for field, bad in [('package_name', 'rocks.aston.hongguotv'), ('variant', 'standard'),
                           ('min_sdk', 23), ('download_url', value['download_url'].replace('android5-', ''))]:
            with self.subTest(field=field):
                manifest.write_text(json.dumps(dict(value, **{field: bad})))
                with self.assertRaises(ValueError):
                    pub.verify_bundle(self.root)

    def test_android5_conflict_rejects_publication_before_any_asset_mutation(self):
        self.bundle()
        value = json.loads((self.root / 'update-android5.json').read_text())
        previous = dict(value, sha256='0' * 64)
        with patch.object(pub, 'read_channel', side_effect=lambda channel: (None, previous if channel == 'update-android5.json' else None)), \
                patch.object(pub, 'api', return_value={'private': False, 'default_branch': 'main'}), \
                patch.object(pub, 'release_by_tag') as lookup, self.assertRaises(ValueError):
            pub.publish(self.root, self.notes)
        lookup.assert_not_called()

    def test_public_repair_still_handles_releases_before_the_android5_channel(self):
        self.bundle()
        (self.root / 'update-android5.json').unlink()
        apk = self.root / 'hongguo-tv-android5-0.2.150.apk'
        apk.unlink()
        apks = sorted(self.root.glob('*.apk'))
        (self.root / 'SHA256SUMS.txt').write_text(''.join(pub.digest(p) + '  ' + p.name + '\n' for p in apks))
        pub.stage_public_bundle(self.root, self.root / 'public')
        manifests, _ = pub.verify_bundle(self.root / 'public')
        self.assertEqual(set(manifests), {'update.json', 'update-mpv.json'})
