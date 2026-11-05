"""Generates the sample label images and CSV files in public/samples.

Run:  python3 tools/make_samples.py     (needs Pillow and numpy)

Every label is drawn from scratch with ordinary fonts, so the files are
original test data. Each one is built to trigger one specific outcome.
"""
import csv
import math
import os
import random
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'samples')
IMG = os.path.join(OUT, 'images')
os.makedirs(IMG, exist_ok=True)

SERIF_B = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
SERIF = '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'
SANS = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
SANS_B = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'

WARNING_BODY = ('(1) According to the Surgeon General, women should not drink alcoholic beverages '
                'during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic '
                'beverages impairs your ability to drive a car or operate machinery, and may cause '
                'health problems.')
WARNING_ALTERED = WARNING_BODY.replace('beverages impairs', 'beverages may impair')

W, H = 1400, 1800


def font(path, size):
    return ImageFont.truetype(path, size)


def fit(draw, text, path, size, max_w):
    while size > 20 and draw.textlength(text, font=font(path, size)) > max_w:
        size -= 2
    return font(path, size)


def centered(draw, y, text, f, fill):
    w = draw.textlength(text, font=f)
    draw.text(((W - w) / 2, y), text, font=f, fill=fill)
    return y + f.size


def draw_label(spec):
    bg = spec.get('bg', (250, 244, 229))
    ink = spec.get('ink', (28, 28, 34))
    accent = spec.get('accent', (122, 28, 28))
    img = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(img)

    d.rectangle([40, 40, W - 40, H - 40], outline=accent, width=10)
    d.rectangle([66, 66, W - 66, H - 66], outline=accent, width=3)

    y = 150
    f = fit(d, spec['brand'], SERIF_B, 130, 1120)
    y = centered(d, y, spec['brand'], f, accent) + 40
    d.line([300, y, W - 300, y], fill=accent, width=4)
    y += 50

    f = fit(d, spec['class'], SERIF, 62, 1100)
    y = centered(d, y, spec['class'], f, ink) + 70

    f = font(SANS_B, 54)
    y = centered(d, y, spec['abv'], f, ink) + 26
    y = centered(d, y, spec['net'], f, ink) + 50

    if spec.get('origin'):
        y = centered(d, y, spec['origin'], font(SANS, 44), ink) + 36

    if spec.get('bottler'):
        y = centered(d, y, spec['bottler'], fit(d, spec['bottler'], SANS, 32, 1150), ink) + 20

    # Government warning block, header and body drawn word by word so the
    # header can be bold (or deliberately not bold).
    if spec.get('warning_body'):
        fb = font(SANS, 31)
        fh = font(SANS_B if spec.get('header_bold', True) else SANS, 31)
        words = [(w_, fh) for w_ in spec['warning_header'].split()] + \
                [(w_, fb) for w_ in spec['warning_body'].split()]
        x0, x1 = 110, W - 110
        wy = H - 520
        x = x0
        line_h = 46
        for word, fnt in words:
            wl = d.textlength(word + ' ', font=fnt)
            if x + wl > x1:
                x = x0
                wy += line_h
            d.text((x, wy), word, font=fnt, fill=ink)
            x += wl
    return img


def glare_and_noise(img, seed):
    rng = np.random.default_rng(seed)
    arr = np.asarray(img).astype(np.float32)
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w * 0.72, h * 0.30
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    glare = np.clip(1 - dist / 420, 0, 1) ** 2 * 0.80
    arr = arr * (1 - glare[..., None]) + 255 * glare[..., None]
    shade = np.linspace(0.86, 1.0, w)[None, :, None]
    arr = arr * shade
    arr += rng.normal(0, 7, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def place_on_table(label, angle):
    """Paste the label onto a dark 'table' at a slight angle, like a phone photo."""
    table = Image.new('RGB', (W + 360, H + 300), (74, 62, 52))
    rng = np.random.default_rng(3)
    t = np.asarray(table).astype(np.float32) + rng.normal(0, 6, (H + 300, W + 360, 3))
    table = Image.fromarray(np.clip(t, 0, 255).astype(np.uint8))
    rot = label.rotate(angle, expand=True, resample=Image.BICUBIC, fillcolor=(74, 62, 52))
    table.paste(rot, ((table.width - rot.width) // 2, (table.height - rot.height) // 2))
    return table


STD = dict(warning_header='GOVERNMENT WARNING:', warning_body=WARNING_BODY, header_bold=True)

LABELS = [
    dict(file='label-01-pass.png', brand='OLD TOM DISTILLERY', **{'class': 'Kentucky Straight Bourbon Whiskey'},
         abv='45% Alc./Vol. (90 Proof)', net='750 mL',
         bottler='Distilled and bottled by Old Tom Distillery, Bardstown, Kentucky', **STD),
    dict(file='label-02-case-difference.png', brand="STONE'S THROW", **{'class': 'Straight Rye Whiskey'},
         abv='50% Alc./Vol. (100 Proof)', net='750 mL', bg=(232, 238, 246), accent=(20, 60, 110),
         bottler="Produced and bottled by Stone's Throw Spirits, Louisville, Kentucky", **STD),
    dict(file='label-03-titlecase-warning.png', brand='Harbor Light Vodka', **{'class': 'Vodka'},
         abv='40% Alc./Vol. (80 Proof)', net='1 L', bg=(238, 244, 240), accent=(24, 84, 70),
         bottler='Bottled by Harbor Light Spirits, Portland, Maine',
         warning_header='Government Warning:', warning_body=WARNING_BODY, header_bold=True),
    dict(file='label-04-wrong-abv.png', brand='Copper Ridge', **{'class': 'Single Malt Whisky'},
         abv='46% Alc./Vol. (92 Proof)', net='700 mL', origin='Product of Scotland', bg=(246, 238, 226),
         accent=(130, 70, 20), bottler='Imported by Copper Ridge Imports, New York, NY', **STD),
    dict(file='label-05-altered-warning.png', brand='Sunset Rum', **{'class': 'Spiced Rum'},
         abv='35% Alc./Vol. (70 Proof)', net='750 mL', bg=(252, 238, 222), accent=(170, 60, 20),
         bottler='Bottled by Sunset Spirits Co., Miami, Florida',
         warning_header='GOVERNMENT WARNING:', warning_body=WARNING_ALTERED, header_bold=True),
    dict(file='label-06-import-ok.png', brand='Pine Hollow', **{'class': 'Blended Scotch Whisky'},
         abv='40% Alc./Vol. (80 Proof)', net='75 cl', origin='Product of Scotland', bg=(236, 240, 232),
         accent=(40, 80, 50), bottler='Imported by Pine Hollow Imports, Chicago, Illinois', **STD),
    dict(file='label-07-missing-warning.png', brand='Redwood Tequila', **{'class': 'Tequila Reposado'},
         abv='40% Alc./Vol. (80 Proof)', net='750 mL', origin='Product of Mexico', bg=(250, 240, 226),
         accent=(150, 40, 30), bottler='Imported by Redwood Imports, Austin, Texas'),
    dict(file='label-08-glare-skew.jpg', brand='Bluewater Gin', **{'class': 'London Dry Gin'},
         abv='47% Alc./Vol. (94 Proof)', net='750 mL', origin='Product of England', bg=(236, 242, 248),
         accent=(20, 70, 120), bottler='Imported by Bluewater Imports, Seattle, Washington', **STD,
         effect='photo'),
    dict(file='label-09-rotated-sideways.png', brand='Silver Creek', **{'class': 'Blended Canadian Whisky'},
         abv='40% Alc./Vol. (80 Proof)', net='750 mL', origin='Product of Canada', bg=(240, 240, 244),
         accent=(60, 60, 90), bottler='Imported by Silver Creek Imports, Detroit, Michigan', **STD,
         effect='rotate90'),
    dict(file='label-10-header-not-bold.png', brand='Granite Peak', **{'class': 'Bourbon Whiskey'},
         abv='47.5% Alc./Vol. (95 Proof)', net='750 mL', bg=(244, 240, 232), accent=(90, 60, 30),
         bottler='Distilled and bottled by Granite Peak Distilling, Denver, Colorado',
         warning_header='GOVERNMENT WARNING:', warning_body=WARNING_BODY, header_bold=False),
]

# Application data that goes with each image (what the applicant declared).
APPS = {
    'label-01-pass.png': ('OLD TOM DISTILLERY', 'Kentucky Straight Bourbon Whiskey', '45', '750 mL', ''),
    'label-02-case-difference.png': ("Stone's Throw", 'Straight Rye Whiskey', '50', '750 mL', ''),
    'label-03-titlecase-warning.png': ('Harbor Light Vodka', 'Vodka', '40', '1 L', ''),
    'label-04-wrong-abv.png': ('Copper Ridge', 'Single Malt Whisky', '43', '700 mL', 'Scotland'),
    'label-05-altered-warning.png': ('Sunset Rum', 'Spiced Rum', '35', '750 mL', ''),
    'label-06-import-ok.png': ('Pine Hollow', 'Blended Scotch Whisky', '40', '750 mL', 'Scotland'),
    'label-07-missing-warning.png': ('Redwood Tequila', 'Tequila Reposado', '40', '750 mL', 'Mexico'),
    'label-08-glare-skew.jpg': ('Bluewater Gin', 'London Dry Gin', '47', '750 mL', 'England'),
    'label-09-rotated-sideways.png': ('Silver Creek', 'Blended Canadian Whisky', '40', '750 mL', 'Canada'),
    'label-10-header-not-bold.png': ('Granite Peak', 'Bourbon Whiskey', '47.5', '750 mL', ''),
}


def main():
    random.seed(7)
    for spec in LABELS:
        img = draw_label(spec)
        effect = spec.get('effect')
        if effect == 'photo':
            img = glare_and_noise(img, 11)
            img = place_on_table(img, 4)
            img = img.filter(ImageFilter.GaussianBlur(1.1))
            img.save(os.path.join(IMG, spec['file']), quality=72)
        else:
            if effect == 'rotate90':
                img = img.rotate(90, expand=True)
            img.save(os.path.join(IMG, spec['file']), optimize=True)
        print('wrote', spec['file'], img.size)

    header = ['id', 'app_brand', 'app_class', 'app_abv', 'app_net', 'app_origin', 'image_file']
    with open(os.path.join(OUT, 'sample-batch-images.csv'), 'w', newline='') as fh:
        wr = csv.writer(fh)
        wr.writerow(header)
        for i, (fname, app) in enumerate(APPS.items(), 1):
            wr.writerow([i, *app, fname])

    with zipfile.ZipFile(os.path.join(OUT, 'sample-batch-images.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(OUT, 'sample-batch-images.csv'), 'sample-batch-images.csv')
        for fname in APPS:
            z.write(os.path.join(IMG, fname), fname)
    print('wrote CSV and zip')


if __name__ == '__main__':
    main()
