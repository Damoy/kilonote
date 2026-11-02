#!/usr/bin/env python3
"""Logo pixel art de KiloNote : Kilo, la disquette.

Les dessins sont des grilles de caractères (un caractère = un pixel) faites à
la main. Ce script en tire tous les fichiers d'icône, sans dépendance :

  src/assets/kilo.svg          mascotte (écran d'accueil, README)
  public/favicon.svg           icône (mode navigateur)
  src-tauri/icons/app-icon.svg icône vectorielle
  src-tauri/icons/*.png        PNG nets (agrandissement « plus proche voisin »)
  src-tauri/icons/icon.ico     ICO Windows multi-tailles : 16, 24, 32, 48, 64, 128, 256
  docs/kilo-1024.png           grande version (source pour `tauri icon`, macOS)

Usage : python3 scripts/generate-icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PALETTE = {
    ".": None,
    "O": (0x1B, 0x18, 0x34),  # contour
    "P": (0x7B, 0x6C, 0xF6),  # corps violet
    "p": (0x5A, 0x4A, 0xD6),  # ombre du corps
    "L": (0xA7, 0x9C, 0xFF),  # reflet du corps
    "S": (0xDD, 0xE1, 0xEB),  # volet métallique
    "s": (0xA4, 0xAA, 0xBE),  # ombre du volet
    "D": (0x2B, 0x28, 0x50),  # fente du volet
    "W": (0xFF, 0xF4, 0xD8),  # étiquette
    "w": (0xEC, 0xDE, 0xB8),  # ombre de l'étiquette
    "E": (0x1B, 0x18, 0x34),  # yeux
    "H": (0xFF, 0xFF, 0xFF),  # reflet des yeux
    "C": (0xFF, 0x8F, 0xA3),  # joues
    "M": (0x1B, 0x18, 0x34),  # bouche
    "g": (0xC4, 0xB6, 0xDA),  # ligne de texte
    "G": (0x3D, 0xDC, 0x84),  # curseur de terminal
    "K": (0xFF, 0xFF, 0xFF),  # lettre K
    "Y": (0xFF, 0xC2, 0x4B),  # crayon
    "y": (0xE0, 0x9A, 0x22),  # ombre du crayon
    "R": (0xFF, 0x8F, 0xA3),  # gomme
    "T": (0xF7, 0xE1, 0xB5),  # bois du crayon
    "Q": (0xB8, 0xBE, 0xD0),  # virole
}

# Icône 32×32 : la disquette, coin coupé en haut à droite, volet avec sa fente,
# un « K » de Kilo, et l'étiquette-visage avec une ligne de terminal.
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

# Icône 16×16 : version simplifiée pour les très petites tailles (barre des tâches à 100 %).
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

# Mascotte 40×40 : la même disquette, avec des bras, des pieds et un crayon.
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
            raise SystemExit(f"ligne {i} : {len(r)} pixels au lieu de {width}")
        for ch in r:
            if ch not in PALETTE:
                raise SystemExit(f"couleur inconnue « {ch} » ligne {i}")
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
    """Réduction par moyenne de blocs (alpha prémultiplié)."""
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
    """ICO contenant des PNG (pris en charge depuis Windows Vista)."""
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, data = b"", b""
    for size, png in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    return header + entries + data


def svg(rows: list[str], label: str, eyes_class: str | None = None) -> str:
    """Un <rect> par suite horizontale de pixels de même couleur, rendu net.

    Avec `eyes_class`, les pixels des yeux (« E ») sont regroupés pour pouvoir
    les animer en CSS (clignement).
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

    # Chaque taille vient du dessin le plus adapté, sans flou.
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
    (ROOT / "src" / "assets" / "kilo.svg").write_text(svg(mascot, "Kilo, la mascotte de KiloNote", eyes_class="kilo-eyes"))
    print("Icônes générées :", ", ".join(f"{s}px" for s in sizes))


if __name__ == "__main__":
    main()
