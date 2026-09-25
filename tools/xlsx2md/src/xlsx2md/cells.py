"""Load used cells, merges, comments, and formatted text from a worksheet."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Any, Iterator

from openpyxl.cell.cell import Cell as XLCell
from openpyxl.comments import Comment
from openpyxl.worksheet.worksheet import Worksheet

from .colors import normalize_rgb

_AUTHOR_DATE = re.compile(r"\([^)]*\d{4}-\d{2}-\d{2}[^)]*\)\s*$")


@dataclass(slots=True)
class Cell:
    row: int
    col: int
    text: str
    fill_rgb: str | None
    font_rgb: str | None
    strike: bool
    bold: bool
    comment: str | None


def format_value(value: Any, *, header: bool = False) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        if value.time() == time(0, 0, 0) and value.microsecond == 0:
            return value.strftime("%Y-%m-%d")
        return value.strftime("%Y-%m-%d %H:%M")
    if isinstance(value, date) and not isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, time):
        return value.strftime("%H:%M")
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    if header:
        text = re.sub(r"[\n]+", "", text)
    else:
        text = re.sub(r"[\n]+", " / ", text)
    return text.strip()


def comment_body(comment: Comment | str | None) -> str | None:
    if comment is None:
        return None
    raw = comment.text if isinstance(comment, Comment) else str(comment)
    if not raw:
        return None
    lines: list[str] = []
    for line in raw.replace("\r", "").split("\n"):
        stripped = line.strip()
        if not stripped or stripped == "======":
            continue
        if stripped.startswith("ID#"):
            continue
        lines.append(stripped)
    if lines and _AUTHOR_DATE.search(lines[0]):
        lines = lines[1:]
    body = " ".join(lines).strip()
    return body or None


def _color_rgb(color: Any) -> str | None:
    if color is None:
        return None
    try:
        ctype = getattr(color, "type", None)
        if ctype in {"theme", "indexed"}:
            return None
        return normalize_rgb(getattr(color, "rgb", None))
    except (TypeError, ValueError, AttributeError):
        return None


def _fill_rgb(cell: XLCell) -> str | None:
    fill = cell.fill
    if fill is None or fill.fill_type in (None, "none"):
        return None
    fg = getattr(fill, "fgColor", None)
    rgb = _color_rgb(fg)
    if rgb:
        return rgb
    pattern = getattr(fill, "fgColor", None)
    if pattern is not None and getattr(pattern, "theme", None) is not None:
        return None
    return _color_rgb(getattr(fill, "bgColor", None))


def _font_rgb(cell: XLCell) -> str | None:
    font = cell.font
    if font is None:
        return None
    return _color_rgb(font.color)


def _iter_existing_cells(ws: Worksheet) -> Iterator[XLCell]:
    stored = getattr(ws, "_cells", None)
    if stored:
        yield from stored.values()
        return
    for row in ws.iter_rows():
        for cell in row:
            if cell.value is not None or cell.comment is not None:
                yield cell


def load_sheet(ws: Worksheet) -> tuple[dict[tuple[int, int], Cell], dict[tuple[int, int], tuple[int, int]]]:
    merge_origin: dict[tuple[int, int], tuple[int, int]] = {}
    for merged in ws.merged_cells.ranges:
        origin = (merged.min_row, merged.min_col)
        for row in range(merged.min_row, merged.max_row + 1):
            for col in range(merged.min_col, merged.max_col + 1):
                merge_origin[(row, col)] = origin

    cells: dict[tuple[int, int], Cell] = {}
    for xl in _iter_existing_cells(ws):
        origin = merge_origin.get((xl.row, xl.column))
        if origin and origin != (xl.row, xl.column) and xl.value is None:
            continue
        text = format_value(xl.value)
        comment = comment_body(xl.comment)
        if not text and not comment:
            continue
        font = xl.font
        cells[(xl.row, xl.column)] = Cell(
            row=xl.row,
            col=xl.column,
            text=text,
            fill_rgb=_fill_rgb(xl),
            font_rgb=_font_rgb(xl),
            strike=bool(font and font.strike),
            bold=bool(font and font.bold),
            comment=comment,
        )
    return cells, merge_origin
