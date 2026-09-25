"""RGB helpers. No palette of product-specific header colors.

Theme indexes follow Excel, not the clrScheme element order. Excel stores
lt1, dk1, lt2, dk2 at indexes 0–3; the theme XML lists dk1, lt1, dk2, lt2.
"""

from __future__ import annotations

from colorsys import hls_to_rgb, rgb_to_hls

from openpyxl.styles.colors import COLOR_INDEX
from openpyxl.xml.functions import fromstring

_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def normalize_rgb(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower().startswith("none") or text.startswith("Values"):
        return None
    hexpart = text.upper().removeprefix("#")
    if len(hexpart) == 8:
        hexpart = hexpart[2:]
    if len(hexpart) != 6 or any(ch not in "0123456789ABCDEF" for ch in hexpart):
        return None
    if hexpart in {"000000", "FFFFFF"}:
        return None
    return hexpart


def has_fill(rgb: str | None) -> bool:
    return bool(rgb)


def hex6(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip().upper().removeprefix("#")
    if len(text) == 8:
        text = text[2:]
    if len(text) != 6 or any(ch not in "0123456789ABCDEF" for ch in text):
        return None
    return text


def apply_tint(rgb: str, tint: float) -> str:
    """Excel tint via HLS. tint 0 leaves the color unchanged."""
    if not tint:
        return rgb
    red, green, blue = (int(rgb[i : i + 2], 16) / 255 for i in (0, 2, 4))
    hue, light, sat = rgb_to_hls(red, green, blue)
    if tint < 0:
        light = light * (1.0 + tint)
    else:
        light = light * (1.0 - tint) + tint
    light = min(1.0, max(0.0, light))
    red, green, blue = hls_to_rgb(hue, light, sat)
    return f"{round(red * 255):02X}{round(green * 255):02X}{round(blue * 255):02X}"


def palette_from_theme(raw: bytes | str | None) -> list[str]:
    if not raw:
        from openpyxl.writer.theme import theme_xml

        raw = theme_xml
    if isinstance(raw, str):
        raw = raw.encode()
    root = fromstring(raw)
    scheme = root.find(f".//{_A}clrScheme")
    xml_colors: list[str] = []
    if scheme is not None:
        for child in list(scheme):
            srgb = child.find(f".//{_A}srgbClr")
            sys = child.find(f".//{_A}sysClr")
            val = None
            if srgb is not None and srgb.get("val"):
                val = srgb.get("val")
            elif sys is not None and sys.get("lastClr"):
                val = sys.get("lastClr")
            xml_colors.append(hex6(val) or "000000")
    if len(xml_colors) < 4:
        return xml_colors
    # XML order dk1, lt1, dk2, lt2 → Excel indexes lt1, dk1, lt2, dk2.
    return [xml_colors[1], xml_colors[0], xml_colors[3], xml_colors[2], *xml_colors[4:]]


def theme_palette(wb: object) -> list[str]:
    return palette_from_theme(getattr(wb, "loaded_theme", None))


def resolve_color(color: object, palette: list[str]) -> str | None:
    """6-digit RGB. Keeps black and white. None when the color is absent."""
    if color is None:
        return None
    ctype = getattr(color, "type", None)
    tint = float(getattr(color, "tint", 0) or 0)
    rgb: str | None = None
    if ctype == "rgb":
        rgb = hex6(getattr(color, "rgb", None))
    elif ctype == "theme":
        index = getattr(color, "theme", None)
        if isinstance(index, int) and 0 <= index < len(palette):
            rgb = palette[index]
    elif ctype == "indexed":
        index = getattr(color, "indexed", None)
        if isinstance(index, int) and 0 <= index < len(COLOR_INDEX):
            rgb = hex6(COLOR_INDEX[index])
    if rgb is None:
        return None
    return apply_tint(rgb, tint)


def mark_fill(rgb: str | None) -> str | None:
    if rgb is None or rgb == "FFFFFF":
        return None
    return rgb


def mark_font(rgb: str | None) -> str | None:
    if rgb is None or rgb == "000000":
        return None
    return rgb
