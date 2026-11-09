import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from linux_playback_pictures import picture_stats, video_crop
from linux_release_source import harness_only

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None


def sample(width=1280, height=720):
    return {'width': width, 'height': height, 'time': 9.7,
            'rect': {'x': 0, 'y': 0, 'width': 1280, 'height': 800},
            'viewport': {'width': 1280, 'height': 800}}


class VideoGeometryTests(unittest.TestCase):
    def test_landscape_crop_stays_inside_video_and_excludes_letterbox(self):
        self.assertEqual(video_crop(sample(), (1280, 800)), (128, 148, 1152, 616))

    def test_portrait_crop_excludes_sidebar_and_background(self):
        left, top, right, bottom = video_crop(sample(720, 1280), (1280, 800))
        self.assertEqual((left, top, right, bottom), (460, 120, 820, 640))

    def test_dpr_and_invalid_geometry(self):
        self.assertEqual(video_crop(sample(), (2560, 1600)), (256, 296, 2304, 1232))
        for width in (0, float('nan')):
            with self.assertRaises(ValueError):
                video_crop(sample(width), (1280, 800))

    def test_only_harness_changes_can_reuse_tagged_application(self):
        self.assertTrue(harness_only(['scripts/linux_playback_pictures.py',
                                     'scripts/verify_linux_playback.py',
                                     'scripts/linux_release_source.py',
                                     '.github/workflows/linux-appimage.yml',
                                     'tests/test_linux_playback_pictures.py']))
        for path in ('core/cmd/hongguotv/ui/app.js', 'desktop/main.go',
                     'scripts/build_linux_appimage.sh', 'scripts/linux_playback_probe.js',
                     'docs/linux-appimage.md', 'go.mod'):
            self.assertFalse(harness_only([path]))


@unittest.skipIf(Image is None, 'Pillow installed by native Linux validation')
class VideoPictureTests(unittest.TestCase):
    def scene(self):
        image = Image.new('RGB', (1280, 800), 'black')
        draw = ImageDraw.Draw(image)
        for x in range(0, 1280, 40):
            draw.rectangle((x, 40, x + 19, 759), fill=(180, 130, 100))
        return image

    def test_dark_centre_pillar_does_not_hide_visible_scene(self):
        image = self.scene()
        ImageDraw.Draw(image).rectangle((480, 40, 800, 759), fill='black')
        self.assertTrue(picture_stats(image, sample())[1])

    def test_black_and_solid_frames_still_fail(self):
        for color in ('black', 'white', (5, 5, 5)):
            self.assertFalse(picture_stats(Image.new('RGB', (1280, 800), color), sample())[1])

    def test_portrait_black_video_cannot_pass_using_bright_sidebars(self):
        image = self.scene()
        ImageDraw.Draw(image).rectangle((415, 0, 865, 799), fill='black')
        self.assertFalse(picture_stats(image, sample(720, 1280))[1])


if __name__ == '__main__':
    unittest.main()
