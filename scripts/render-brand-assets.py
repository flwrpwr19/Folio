#!/usr/bin/env python3
"""Compose Folio's checked-in brand artwork from generated texture bases."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
FONT = Path("/System/Library/Fonts/SFNS.ttf")


def load_font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT), size=size)


def render_dmg(source: Path) -> None:
    output = ROOT / "assets/brand/dmg-installer-background.png"
    image = ImageOps.fit(Image.open(source).convert("RGB"), (1600, 1000))
    image = image.filter(ImageFilter.GaussianBlur(radius=42)).convert("RGBA")
    image.alpha_composite(Image.new("RGBA", image.size, (3, 4, 6, 54)))

    draw = ImageDraw.Draw(image, "RGBA")
    line_y = 462
    draw.line((530, line_y, 1000, line_y), fill=(194, 198, 205, 94), width=3)
    draw.line((968, line_y - 20, 1000, line_y), fill=(194, 198, 205, 94), width=3)
    draw.line((968, line_y + 20, 1000, line_y), fill=(194, 198, 205, 94), width=3)
    image.convert("RGB").save(output, optimize=True)


def render_banner(source: Path) -> None:
    output = ROOT / "assets/brand/folio-readme-banner.png"
    image = ImageOps.fit(Image.open(source).convert("RGB"), (1600, 640)).convert("RGBA")
    image.alpha_composite(Image.new("RGBA", image.size, (2, 3, 5, 38)))

    icon = Image.open(ROOT / "src-tauri/app-icon.png").convert("RGBA")
    icon.thumbnail((236, 236), Image.Resampling.LANCZOS)
    mask = Image.new("L", icon.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, icon.width - 1, icon.height - 1),
        radius=48,
        fill=255,
    )
    icon.putalpha(mask)
    image.alpha_composite(icon, (112, 202))

    draw = ImageDraw.Draw(image, "RGBA")
    draw.text((404, 206), "Folio", font=load_font(132), fill=(246, 246, 247, 255))
    draw.text(
        (412, 362),
        "Fast, private media browsing for macOS",
        font=load_font(32),
        fill=(190, 194, 202, 230),
    )
    draw.line((414, 426, 702, 426), fill=(181, 186, 195, 94), width=2)
    image.convert("RGB").save(output, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dmg-base", required=True, type=Path)
    parser.add_argument("--banner-base", required=True, type=Path)
    args = parser.parse_args()
    render_dmg(args.dmg_base)
    render_banner(args.banner_base)


if __name__ == "__main__":
    main()
