#!/usr/bin/env python3

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ICON_ROOT = ROOT / "packages" / "app" / "assets" / "icons"
SOURCE_PATH = ICON_ROOT / "source" / "invoker-logo.png"
PNG_DIR = ICON_ROOT / "png"
ICO_PATH = ICON_ROOT / "win" / "icon.ico"
ICNS_PATH = ICON_ROOT / "mac" / "icon.icns"

PNG_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024]
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (96, 96), (128, 128), (256, 256)]
ICNS_SIZES = [(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)]


def resolve_input_path() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1]).expanduser().resolve()
    return SOURCE_PATH


def load_source_image(source_path: Path) -> Image.Image:
    if not source_path.exists():
        raise SystemExit(f"Source image not found: {source_path}")

    image = Image.open(source_path).convert("RGBA")
    width, height = image.size
    if width != height:
        size = max(width, height)
        square = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        square.alpha_composite(image, ((size - width) // 2, (size - height) // 2))
        image = square
    return image


def ensure_dirs() -> None:
    (ICON_ROOT / "source").mkdir(parents=True, exist_ok=True)
    PNG_DIR.mkdir(parents=True, exist_ok=True)
    ICO_PATH.parent.mkdir(parents=True, exist_ok=True)
    ICNS_PATH.parent.mkdir(parents=True, exist_ok=True)


def save_outputs(base: Image.Image, source_path: Path) -> None:
    ensure_dirs()
    if source_path != SOURCE_PATH:
        base.save(SOURCE_PATH)

    for size in PNG_SIZES:
        resized = base.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(PNG_DIR / f"{size}x{size}.png")

    base.save(ICO_PATH, sizes=ICO_SIZES)
    base.save(ICNS_PATH, format="ICNS", sizes=ICNS_SIZES)


def main() -> None:
    source_path = resolve_input_path()
    image = load_source_image(source_path)
    save_outputs(image, source_path)
    print(f"Used source image: {source_path}")
    print(f"Canonical source image: {SOURCE_PATH}")
    print(f"Generated PNG ladder in: {PNG_DIR}")
    print(f"Generated Windows icon: {ICO_PATH}")
    print(f"Generated macOS icon: {ICNS_PATH}")


if __name__ == "__main__":
    main()
