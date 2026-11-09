"""Sample displayed video content without sidebars, letterboxing or controls."""
import math


def video_crop(sample, picture_size):
    rect, viewport = sample['rect'], sample['viewport']
    width, height = float(sample['width']), float(sample['height'])
    values = [width, height, rect['width'], rect['height'], viewport['width'], viewport['height']]
    if any(not math.isfinite(value) or value <= 0 for value in values):
        raise ValueError('Invalid video geometry')
    # The player uses object-fit: contain. Exclude letterboxing before sampling
    # most of the picture; a narrow centre strip may be a dark coat or pillar.
    scale = min(rect['width'] / width, rect['height'] / height)
    displayed_width, displayed_height = width * scale, height * scale
    x = rect['x'] + (rect['width'] - displayed_width) / 2
    y = rect['y'] + (rect['height'] - displayed_height) / 2
    sx, sy = picture_size[0] / viewport['width'], picture_size[1] / viewport['height']
    crop = (max(0, int((x + displayed_width * .1) * sx)),
            max(0, int((y + displayed_height * .15) * sy)),
            min(picture_size[0], int((x + displayed_width * .9) * sx)),
            min(picture_size[1], int((y + displayed_height * .8) * sy)))
    if crop[2] <= crop[0] or crop[3] <= crop[1]:
        raise ValueError('Video is outside the captured viewport')
    return crop


def picture_stats(picture, sample):
    from PIL import ImageStat
    crop = video_crop(sample, picture.size)
    stat = ImageStat.Stat(picture.crop(crop).resize((64, 64)))
    return {'mean_rgb': stat.mean, 'spread_rgb': stat.stddev, 'time': sample['time'],
            'video_crop': list(crop)}, max(stat.mean) >= 8 and max(stat.stddev) >= 3
