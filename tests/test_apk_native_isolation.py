import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('verify_apks', Path(__file__).parents[1] / 'scripts/verify_apks.py')
verify_apks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_apks)


class NativeLibraryIsolationTest(unittest.TestCase):
    def names(self, variant):
        names = [f'lib/{abi}/libhongguotv.so' for abi in ('arm64-v8a', 'armeabi-v7a', 'x86_64')]
        if variant == 'mpv':
            names += [f'lib/{abi}/{lib}' for abi in ('arm64-v8a', 'armeabi-v7a', 'x86_64')
                      for lib in ('libmpv.so', 'libhongguompv.so')]
            names += ['assets/mpv-notices.txt']
        return names

    def test_standard_has_only_core_and_mpv_keeps_its_own_libraries(self):
        for variant in ('standard', 'mpv'):
            with self.subTest(variant=variant):
                verify_apks.verify_native_libraries(self.names(variant), variant)

    def test_nextlib_cannot_return_in_any_abi_or_under_a_versioned_name(self):
        for library in ('libavcodec.so', 'libavcodec63.so', 'libmedia3ext.so', 'libffmpeg.so'):
            with self.subTest(library=library), self.assertRaises(AssertionError):
                verify_apks.verify_native_libraries(self.names('standard') + ['lib/armeabi-v7a/' + library], 'standard')

    def test_mpv_libraries_cannot_leak_into_standard_and_all_abis_remain_required(self):
        with self.assertRaises(AssertionError):
            verify_apks.verify_native_libraries(self.names('mpv'), 'standard')
        with self.assertRaises(AssertionError):
            verify_apks.verify_native_libraries(self.names('standard')[1:], 'standard')
        with self.assertRaises(AssertionError):
            verify_apks.verify_native_libraries(self.names('standard') + ['assets/media3-ffmpeg-notices.txt'], 'standard')
