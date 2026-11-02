#!/usr/bin/env python3
"""KiloNote's pixel art logo: Kilo, the floppy disk.

The drawings are hand-made character grids (one character = one pixel).
This script turns them into every icon file, with no dependency:

  src/assets/kilo.svg          mascot (welcome screen, README)
  public/favicon.svg           icon (browser mode)
  src-tauri/icons/app-icon.svg vector icon
  src-tauri/icons/*.png        crisp PNGs ("nearest neighbor" upscaling)
  src-tauri/icons/icon.ico     multi-size Windows ICO: 16, 24, 32, 48, 64, 128, 256
  docs/kilo-1024.png           large version (source for `tauri icon`, macOS)

Usage: python3 scripts/generate-icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PALETTE = {
    ".": None,
    "O": (0x1B, 0x18, 0x34),  # outline
    "P": (0x7B, 0x6C, 0xF6),  # purple body
    "p": (0x5A, 0x4A, 0xD6),  # body shade
    "L": (0xA7, 0x9C, 0xFF),  # body highlight
    "S": (0xDD, 0xE1, 0xEB),  # metal shutter
    "s": (0xA4, 0xAA, 0xBE),  # shutter shade
    "D": (0x2B, 0x28, 0x50),  # shutter slot
    "W": (0xFF, 0xF4, 0xD8),  # label
    "w": (0xEC, 0xDE, 0xB8),  # label shade
    "E": (0x1B, 0x18, 0x34),  # eyes
    "H": (0xFF, 0xFF, 0xFF),  # eye highlight
    "C": (0xFF, 0x8F, 0xA3),  # cheeks
    "M": (0x1B, 0x18, 0x34),  # mouth
    "g": (0xC4, 0xB6, 0xDA),  # text line
    "G": (0x3D, 0xDC, 0x84),  # terminal cursor
    "K": (0xFF, 0xFF, 0xFF),  # letter K
    "Y": (0xFF, 0xC2, 0x4B),  # pencil
    "y": (0xE0, 0x9A, 0x22),  # pencil shade
    "R": (0xFF, 0x8F, 0xA3),  # eraser
    "T": (0xF7, 0xE1, 0xB5),  # pencil wood
    "Q": (0xB8, 0xBE, 0xD0),  # ferrule
}

# 32×32 icon: the floppy disk, cut top-right corner, shutter with its slot,
# a "K" for Kilo, and the face label with a terminal line.
ICON_32 = """
................................
................................
...OOOOOOOOOOOOOOOOOOOOOOOO.....
..OLLLLLLOSSSSSSSSSSSOLLLLPO....
..OLKPPKPOSSSSSSDDDSsOPPPPPPO...
..OLKPKPPOSSSSSSDDDSsOPPPPPPpO..
..OLKKPPPOSSSSSSDDDSsOPPPPPPpO..
..OLKPKPPOSSSSSSDDDSsOPPPPPPpO..
..OLKPPKPOSSSSSSDDDSsOPPPPPPpO..
..OLPPPPPOSSSSSSDDDSsOPPPPPPpO..
..OLPPPPPOsssssssssssOPPPPPPpO..
..OLPPPPPOOOOOOOOOOOOOPPPPPPpO..
..OLPPPPPPPPPPPPPPPPPPPPPPPPpO..
..OLPPPPPPPPPPPPPPPPPPPPPPPPpO..
..OLPPOOOOOOOOOOOOOOOOOOOOPPpO..
..OLPPOWWWWWWWWWWWWWWWWWWOPPpO..
..OLPPOWWWWWWWWWWWWWWWWWwOPPpO..
..OLPPOWWWEEWWWWWWWWEEWWwOPPpO..
..OLPPOWWWEEWWWWWWWWEEWWwOPPpO..
..OLPPOWWWEEWWWWWWWWEEWWwOPPpO..
..OLPPOWWWWWWWWWWWWWWWWWwOPPpO..
..OLPPOWCCWWWMWWWWMWWWCCwOPPpO..
..OLPPOWWWWWWWMMMMWWWWWWwOPPpO..
..OLPPOWWWWWWWWWWWWWWWWWwOPPpO..
..OLPPOWWWWWWWWWWWWWGGWWwOPPpO..
..OLPPOWWgggggggggWWGGWWwOPPpO..
..OLPPOWwwwwwwwwwwwwwwwwwOPPpO..
..OLPPOOOOOOOOOOOOOOOOOOOOPPpO..
..OLpppppppppppppppppppppppppO..
...OOOOOOOOOOOOOOOOOOOOOOOOOO...
................................
................................
"""

# 16×16 icon: simplified version for very small sizes (taskbar at 100% scaling).
ICON_16 = """
................
.OOOOOOOOOOOO...
OLLOSSSSDSOPPO..
OLPOSSSSDSOPPPO.
OLPOSSSSDSOPPPO.
OLPOOOOOOOOPPPO.
OLPPPPPPPPPPPPO.
OLPWWWWWWWWWWPO.
OLPWEEWWWWEEWPO.
OLPWEEWWWWEEWPO.
OLPWCWWMMWWCWPO.
OLPWWWWWWWGWWPO.
OLPWggggWWGWWPO.
OLppppppppppppO.
.OOOOOOOOOOOOO..
................
"""

# 40×40 mascot: the same floppy disk, with arms, feet and a pencil.
MASCOT_40 = """
........................................
........................................
........................................
........................................
.....OOOOOOOOOOOOOOOOOOOOOOOO...........
....OLLLLLLOSSSSSSSSSSSOLLLLPO..........
....OLKPPKPOSSSSSSDDDSsOPPPPPPO.........
....OLKPKPPOSSSSSSDDDSsOPPPPPPpO........
....OLKKPPPOSSSSSSDDDSsOPPPPPPpO........
....OLKPKPPOSSSSSSDDDSsOPPPPPPpO...OO...
....OLKPPKPOSSSSSSDDDSsOPPPPPPpO..ORRO..
....OLPPPPPOSSSSSSDDDSsOPPPPPPpO..ORRO..
....OLPPPPPOsssssssssssOPPPPPPpO..OQQO..
....OLPPPPPOOOOOOOOOOOOOPPPPPPpO..OYyO..
....OLPPPPPPPPPPPPPPPPPPPPPPPPpO..OYyO..
....OLPPPPPPPPPPPPPPPPPPPPPPPPpO..OYyO..
....OLPPOOOOOOOOOOOOOOOOOOOOPPpO..OYyO..
....OLPPOWWWWWWWWWWWWWWWWWWOPPpO..OYyO..
....OLPPOWWWWWWWWWWWWWWWWWwOPPpO..OYyO..
.OOOOLPPOWWWEEWWWWWWWWEEWWwOPPpOOOOOOO..
OPPPOLPPOWWWEEWWWWWWWWEEWWwOPPpOPPPPPO..
OPPPOLPPOWWWEEWWWWWWWWEEWWwOPPpOPPPPPO..
OpPPOLPPOWWWWWWWWWWWWWWWWWwOPPpOPPPppO..
.OOOOLPPOWCCWWWMWWWWMWWWCCwOPPpOOOOOOO..
....OLPPOWWWWWWWMMMMWWWWWWwOPPpO..OTTO..
....OLPPOWWWWWWWWWWWWWWWWWwOPPpO...OO...
....OLPPOWWWWWWWWWWWWWGGWWwOPPpO........
....OLPPOWWgggggggggWWGGWWwOPPpO........
....OLPPOWwwwwwwwwwwwwwwwwwOPPpO........
....OLPPOOOOOOOOOOOOOOOOOOOOPPpO........
....OLpppppppppppppppppppppppppO........
.....OOOOOOOOOOOOOOOOOOOOOOOOOO.........
..........OpO...........OpO.............
........OpppO...........OpppO...........
........OOOOO...........OOOOO...........
........................................
........................................
........................................
........................................
........................................
"""


def parse(art: str) -> list[str]:
    rows = [r for r in art.strip("\n").split("\n")]
    width = len(rows[0])
    for i, r in enumerate(rows):
        if len(r) != width:
            raise SystemExit(f"row {i}: {len(r)} pixels instead of {width}")
        for ch in r:
            if ch not in PALETTE:
                raise SystemExit(f"unknown color \"{ch}\" on row {i}")
    return rows


def to_rgba(rows: list[str]) -> list[list[tuple[int, int, int, int]]]:
    out = []
    for r in rows:
        line = []
        for ch in r:
            c = PALETTE[ch]
            line.append((0, 0, 0, 0) if c is None else (*c, 255))
        out.append(line)
    return out


def scale_nearest(px, factor: int):
    return [[p for p in row for _ in range(factor)] for row in px for _ in range(factor)]


def downscale_box(px, factor: int):
    """Downscaling by block averaging (premultiplied alpha)."""
    h, w = len(px) // factor, len(px[0]) // factor
    out = []
    for y in range(h):
        line = []
        for x in range(w):
            r = g = b = a = 0
            for dy in range(factor):
                for dx in range(factor):
                    pr, pg, pb, pa = px[y * factor + dy][x * factor + dx]
                    r += pr * pa; g += pg * pa; b += pb * pa; a += pa
            n = factor * factor
            line.append((r // a, g // a, b // a, a // n) if a else (0, 0, 0, 0))
        out.append(line)
    return out


def png_bytes(px) -> bytes:
    h, w = len(px), len(px[0])
    raw = b"".join(b"\x00" + bytes(c for p in row for c in p) for row in px)
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico_bytes(images: list[tuple[int, bytes]]) -> bytes:
    """ICO containing PNGs (supported since Windows Vista)."""
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, data = b"", b""
    for size, png in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    return header + entries + data


def svg(rows: list[str], label: str, eyes_class: str | None = None) -> str:
    """One <rect> per horizontal run of same-colored pixels, crisp rendering.

    With `eyes_class`, the eye pixels ("E") are grouped so that CSS can
    animate them (blinking).
    """
    w = len(rows[0])
    by_color: dict[str, list[str]] = {}
    eyes: list[str] = []
    for y, r in enumerate(rows):
        x = 0
        while x < w:
            ch = r[x]
            run = 1
            while x + run < w and r[x + run] == ch:
                run += 1
            if PALETTE[ch] is not None:
                rect = f'<rect x="{x}" y="{y}" width="{run}" height="1"'
                if eyes_class and ch == "E":
                    eyes.append(f'{rect} fill="{hexa(ch)}"/>')
                else:
                    by_color.setdefault(ch, []).append(rect + "/>")
            x += run
    parts = [f'<g fill="{hexa(ch)}">{"".join(rects)}</g>' for ch, rects in by_color.items()]
    if eyes:
        parts.append(f'<g class="{eyes_class}">{"".join(eyes)}</g>')
    h = len(rows)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" shape-rendering="crispEdges" role="img" aria-label="{label}">'
        f"<title>{label}</title>{''.join(parts)}</svg>\n"
    )


def hexa(ch: str) -> str:
    r, g, b = PALETTE[ch]  # type: ignore[misc]
    return f"#{r:02X}{g:02X}{b:02X}"


def main() -> None:
    icon32, icon16, mascot = parse(ICON_32), parse(ICON_16), parse(MASCOT_40)
    assert len(icon32) == 32 and len(icon16) == 16 and len(mascot) == 40
    px32, px16 = to_rgba(icon32), to_rgba(icon16)

    icons = ROOT / "src-tauri" / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    (ROOT / "docs").mkdir(exist_ok=True)

    # Each size comes from the best-suited drawing, without blur.
    sizes = {
        16: px16,
        24: downscale_box(scale_nearest(px32, 3), 4),
        32: px32,
        48: scale_nearest(px16, 3),
        64: scale_nearest(px32, 2),
        128: scale_nearest(px32, 4),
        256: scale_nearest(px32, 8),
    }
    pngs = {s: png_bytes(p) for s, p in sizes.items()}
    (icons / "icon.ico").write_bytes(ico_bytes(sorted(pngs.items())))
    (icons / "32x32.png").write_bytes(pngs[32])
    (icons / "64x64.png").write_bytes(pngs[64])
    (icons / "128x128.png").write_bytes(pngs[128])
    (icons / "128x128@2x.png").write_bytes(pngs[256])
    (icons / "icon.png").write_bytes(png_bytes(scale_nearest(px32, 16)))
    (ROOT / "docs" / "kilo-1024.png").write_bytes(png_bytes(scale_nearest(px32, 32)))

    (icons / "app-icon.svg").write_text(svg(icon32, "KiloNote"))
    (ROOT / "public" / "favicon.svg").write_text(svg(icon32, "KiloNote"))
    (ROOT / "src" / "assets" / "kilo.svg").write_text(svg(mascot, "Kilo, the KiloNote mascot", eyes_class="kilo-eyes"))
    print("Icons generated:", ", ".join(f"{s}px" for s in sizes))


if __name__ == "__main__":
    main()
