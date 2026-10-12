from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'extension' / 'icons'
root.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128):
    scale = 4
    image = Image.new('RGBA', (size * scale, size * scale))
    draw = ImageDraw.Draw(image)
    unit = size * scale / 128
    box = lambda values: tuple(round(n * unit) for n in values)
    draw.rounded_rectangle(box((1, 1, 127, 127)), radius=round(29 * unit), fill='#214E42')
    for x in (27, 57, 87):
        for y in (27, 57, 87):
            color = '#D2B477' if (x, y) in ((57, 27), (87, 57), (27, 87)) else '#F5F0E5'
            draw.rounded_rectangle(box((x - 4, y - 4, x + 18, y + 18)), radius=max(1, round(5 * unit)), fill=color)
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / f'icon{size}.png')
print('Generated 4 local PNG icons.')
