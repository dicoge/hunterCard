#!/usr/bin/env python3
"""Generate HoloHunter app assets: icon, adaptive-icon, splash-icon.

iOS icon: fully opaque 1024×1024 square — no pre-cut corners (iOS applies its own mask).
Android adaptive-icon: transparent-bg foreground within 66.7% safe zone.
Splash-icon: centered logo on transparent bg.
"""

import os
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

SIZE = 1024
OUT_DIR = Path(__file__).resolve().parent.parent / "assets"

COLOR_PRIMARY = (30, 58, 95)
COLOR_ACCENT = (212, 175, 55)
COLOR_WHITE = (255, 255, 255)
COLOR_DARK = (18, 18, 24)

FONT_CANDIDATES = [
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
]


def get_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def generate_icon():
    """1024×1024 — fully opaque square (no alpha, no pre-rounded corners)."""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    bg = Image.new("RGBA", (SIZE, SIZE), COLOR_PRIMARY)
    img.paste(bg, (0, 0))

    card_cx, card_cy = SIZE // 2, int(SIZE * 0.46)
    card_w, card_h = int(SIZE * 0.32), int(SIZE * 0.44)
    card_radius = int(SIZE * 0.06)
    overlay_card = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    card_draw = ImageDraw.Draw(overlay_card)
    card_draw.rounded_rectangle(
        [
            (card_cx - card_w // 2, card_cy - card_h // 2),
            (card_cx + card_w // 2, card_cy + card_h // 2),
        ],
        radius=card_radius,
        fill=COLOR_DARK,
        outline=COLOR_ACCENT,
        width=max(3, int(SIZE * 0.008)),
    )
    img = Image.alpha_composite(img, overlay_card)

    text = "HH"
    font = get_font(int(SIZE * 0.28), bold=True)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    text_overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_overlay)
    text_draw.text(
        (card_cx - tw // 2 - bbox[0], card_cy - th // 2 - bbox[1] - int(SIZE * 0.02)),
        text,
        font=font,
        fill=COLOR_ACCENT,
    )
    img = Image.alpha_composite(img, text_overlay)

    diamond = "◆"
    font_small = get_font(int(SIZE * 0.07), bold=True)
    small_bbox = text_draw.textbbox((0, 0), diamond, font=font_small)
    sw, sh = small_bbox[2] - small_bbox[0], small_bbox[3] - small_bbox[1]
    deco_overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    deco_draw = ImageDraw.Draw(deco_overlay)
    for offset_x in [-1, 1]:
        for offset_y in [-1, 1]:
            deco_draw.text(
                (
                    card_cx - sw // 2 - small_bbox[0] + offset_x * int(SIZE * 0.078),
                    card_cy - sh // 2 - small_bbox[1] + card_h // 2 + offset_y * int(SIZE * 0.06),
                ),
                diamond,
                font=font_small,
                fill=COLOR_ACCENT,
            )
    img = Image.alpha_composite(img, deco_overlay)

    label = "HoloHunter"
    label_font = get_font(int(SIZE * 0.06))
    label_bbox = text_draw.textbbox((0, 0), label, font=label_font)
    lw = label_bbox[2] - label_bbox[0]
    label_overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    label_draw = ImageDraw.Draw(label_overlay)
    label_draw.text(
        (SIZE // 2 - lw // 2 - label_bbox[0], int(SIZE * 0.88)),
        label,
        font=label_font,
        fill=(180, 200, 230),
    )
    img = Image.alpha_composite(img, label_overlay)

    opaque = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
    opaque.paste(img, (0, 0), img)
    out = OUT_DIR / "icon.png"
    opaque.save(out, "PNG")

    total = SIZE * SIZE
    transparent = sum(
        1 for y in range(SIZE) for x in range(SIZE)
        if img.getpixel((x, y))[3] == 0
    )
    print(f"  ✓ {out} ({opaque.size[0]}×{opaque.size[1]}, opaque, {transparent}/{total} transparent pixels in source before flatten)")

    if transparent > 0:
        verified = Image.open(out)
        non_opaque = sum(
            1 for y in range(SIZE) for x in range(SIZE)
            if verified.getpixel((x, y)) != opaque.getpixel((x, y))
        )
        print(f"    verified saved file: {non_opaque} non-opaque pixels (expect 0)")


def generate_adaptive_icon():
    """1024×1024 adaptive foreground — transparent bg, safe-zone padded."""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    safe_margin = int(SIZE * 0.1667)
    safe_size = SIZE - 2 * safe_margin
    cx, cy = SIZE // 2, SIZE // 2
    circle_r = safe_size // 2

    bg_circle = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    circle_draw = ImageDraw.Draw(bg_circle)
    circle_draw.ellipse(
        [(cx - circle_r, cy - circle_r), (cx + circle_r, cy + circle_r)],
        fill=COLOR_PRIMARY,
        outline=COLOR_ACCENT,
        width=max(3, int(SIZE * 0.006)),
    )
    img = Image.alpha_composite(img, bg_circle)

    text = "HH"
    font = get_font(int(SIZE * 0.26), bold=True)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    text_overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_overlay)
    text_draw.text(
        (cx - tw // 2 - bbox[0], cy - th // 2 - bbox[1] - int(SIZE * 0.01)),
        text,
        font=font,
        fill=COLOR_ACCENT,
    )
    img = Image.alpha_composite(img, text_overlay)

    out = OUT_DIR / "adaptive-icon.png"
    img.save(out, "PNG")
    print(f"  ✓ {out} ({img.size[0]}×{img.size[1]}, RGBA with transparency)")


def generate_splash():
    """1024×1024 splash logo — transparent bg, centered HoloHunter mark."""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    cx, cy = SIZE // 2, SIZE // 2

    card_mark_w, card_mark_h = int(SIZE * 0.28), int(SIZE * 0.38)
    card_radius = int(SIZE * 0.05)
    card_x0 = cx - card_mark_w // 2
    card_y0 = cy - card_mark_h // 2 - int(SIZE * 0.1)
    draw.rounded_rectangle(
        [
            (card_x0, card_y0),
            (card_x0 + card_mark_w, card_y0 + card_mark_h),
        ],
        radius=card_radius,
        fill=COLOR_PRIMARY,
        outline=COLOR_ACCENT,
        width=max(3, int(SIZE * 0.008)),
    )

    text_icon = "HH"
    font_big = get_font(int(SIZE * 0.22), bold=True)
    bbox_big = draw.textbbox((0, 0), text_icon, font=font_big)
    tw_big = bbox_big[2] - bbox_big[0]
    th_big = bbox_big[3] - bbox_big[1]
    draw.text(
        (
            cx - tw_big // 2 - bbox_big[0],
            card_y0 + card_mark_h // 2 - th_big // 2 - bbox_big[1] - int(SIZE * 0.01),
        ),
        text_icon,
        font=font_big,
        fill=COLOR_ACCENT,
    )

    label = "HoloHunter"
    font_label = get_font(int(SIZE * 0.1), bold=True)
    label_bbox = draw.textbbox((0, 0), label, font=font_label)
    lw = label_bbox[2] - label_bbox[0]
    draw.text(
        (cx - lw // 2 - label_bbox[0], cy + int(SIZE * 0.22)),
        label,
        font=font_label,
        fill=COLOR_PRIMARY,
    )

    tagline = "hololive OCG Card Tool"
    font_tag = get_font(int(SIZE * 0.05))
    tag_bbox = draw.textbbox((0, 0), tagline, font=font_tag)
    tw_tag = tag_bbox[2] - tag_bbox[0]
    draw.text(
        (cx - tw_tag // 2 - tag_bbox[0], cy + int(SIZE * 0.36)),
        tagline,
        font=font_tag,
        fill=(100, 120, 160),
    )

    disclaimer = "Unofficial · Unaffiliated · Not Endorsed"
    font_disc = get_font(int(SIZE * 0.035))
    disc_bbox = draw.textbbox((0, 0), disclaimer, font=font_disc)
    tw_disc = disc_bbox[2] - disc_bbox[0]
    draw.text(
        (cx - tw_disc // 2 - disc_bbox[0], cy + int(SIZE * 0.44)),
        disclaimer,
        font=font_disc,
        fill=(150, 150, 160),
    )

    out = OUT_DIR / "splash-icon.png"
    img.save(out, "PNG")
    print(f"  ✓ {out} ({img.size[0]}×{img.size[1]}, RGBA with transparency)")


def main():
    print("Generating HoloHunter assets …")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for src in ["icon.png", "adaptive-icon.png", "splash-icon.png"]:
        src_path = OUT_DIR / src
        bak = OUT_DIR / f"{src}.bak"
        if src_path.exists() and not bak.exists():
            src_path.rename(bak)
            print(f"  ↳ backed up → {bak.name}")

    generate_icon()
    generate_adaptive_icon()
    generate_splash()

    print("\nDone.")
    print("- icon.png: 1024×1024 fully opaque square (no alpha, no pre-rounded corners)")
    print("- adaptive-icon.png: foreground within 66.7% safe zone, transparent bg")
    print("- splash-icon.png: centered logo on transparent bg")


if __name__ == "__main__":
    main()
