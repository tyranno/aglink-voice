"""Builds media/aglink-icons.woff: a mic with 1-3 sound waves, drawn on the
codicon 16px grid (300 units per em) so it sits like a built-in icon.
Run: py -3 tools/gen-icons.py (needs fonttools)."""
import math
import os
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

S = 300 / 16  # font units per grid pixel


def arc(cx, cy, r, a0, a1, n=24):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)), cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def band(cx, cy, r_in, r_out, a0, a1):
    return arc(cx, cy, r_out, a0, a1) + arc(cx, cy, r_in, a1, a0)


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x0, y1), (x1, y1), (x1, y0)]


def capsule(cx, y0, y1, r):
    return arc(cx, y1 - r, r, 0, 180) + arc(cx, y0 + r, r, 180, 360)


def clockwise(pts):
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))
    return pts[::-1] if area > 0 else pts


MIC = [
    capsule(5, 6.5, 14.5, 2),  # head
    band(5, 9.5, 3, 4, 180, 360),  # holder
    rect(4.5, 2, 5.5, 5.5),  # stem
    rect(2.5, 1, 7.5, 2),  # base
]
WAVES = [band(5, 10.5, r, r + 1.1, -a, a) for r, a in ((5.2, 40), (7.4, 34), (9.6, 29))]


def glyph(shapes):
    pen = TTGlyphPen(None)
    for pts in shapes:
        pts = clockwise([(round(x * S), round(y * S)) for x, y in pts])
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
    return pen.glyph()


names = [".notdef"] + [f"hear{i}" for i in (1, 2, 3)]
glyphs = {".notdef": TTGlyphPen(None).glyph()}
for i in (1, 2, 3):
    glyphs[f"hear{i}"] = glyph(MIC + WAVES[:i])
fb = FontBuilder(300, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap({0xE001: "hear1", 0xE002: "hear2", 0xE003: "hear3"})
fb.setupGlyf(glyphs)
fb.setupHorizontalMetrics({n: (300, 0) for n in names})
fb.setupHorizontalHeader(ascent=300, descent=0)
fb.setupNameTable({"familyName": "aglink-icons", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=300, sTypoDescender=0, usWinAscent=300, usWinDescent=0)
fb.setupPost()
fb.font.flavor = "woff"
out = os.path.join(os.path.dirname(__file__), "..", "media", "aglink-icons.woff")
fb.save(out)
print("wrote", os.path.normpath(out))
