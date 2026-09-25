"""JSON sidecar: colors, comments, and merges, each mapped back into the Markdown."""

from __future__ import annotations

import json
from pathlib import Path

from openpyxl.workbook import Workbook

from .colors import theme_palette
from .facts import collect_sheet
from .tables import WorkbookModel


def index_locs(model: WorkbookModel) -> dict[tuple[str, str], dict]:
    from .convert import banner_spans

    locs: dict[tuple[str, str], dict] = {}
    for sheet, addr, key in model.meta_refs:
        if addr:
            locs[(sheet, addr)] = {"section": "meta", "role": "meta", "key": key}
    for table in model.tables:
        sheet = table.source_sheet
        section = table.name
        for text, addr in zip(table.intro, table.intro_addrs):
            if addr:
                locs[(sheet, addr)] = {"section": section, "role": "intro", "text": text}
        for (key, _value), (label_at, value_at) in zip(table.pairs, table.pair_addrs):
            if label_at:
                locs[(sheet, label_at)] = {"section": section, "role": "pair", "key": key}
            if value_at:
                locs[(sheet, value_at)] = {"section": section, "role": "pair", "key": key}
        for header, addrs in zip(table.headers, table.header_addrs):
            for addr in addrs:
                if addr and (sheet, addr) not in locs:
                    locs[(sheet, addr)] = {"section": section, "role": "header", "header": header}
        if table.sparse:
            for row, addrs in zip(table.rows, table.row_addrs):
                for text, addr in zip(row, addrs):
                    if addr and (sheet, addr) not in locs:
                        locs[(sheet, addr)] = {"section": section, "role": "outline", "text": text}
            continue
        for title, title_index, start, end in banner_spans(table.rows):
            if title_index is not None and title_index < len(table.row_addrs):
                for addr in table.row_addrs[title_index]:
                    if addr:
                        locs[(sheet, addr)] = {"section": section, "role": "banner", "text": title}
                        break
            row_no = 0
            for offset in range(start, end):
                row_no += 1
                if offset >= len(table.row_addrs):
                    break
                row = table.rows[offset]
                addrs = table.row_addrs[offset]
                for header, text, addr in zip(table.headers, row, addrs):
                    if not addr or (sheet, addr) in locs:
                        continue
                    loc: dict = {"section": section, "role": "cell", "header": header, "row": row_no}
                    if title:
                        loc["banner"] = title
                    if text:
                        loc["text"] = text
                    locs[(sheet, addr)] = loc
    return locs


def _colors(marks: list[dict], merges: list[dict]) -> dict[str, list[str]]:
    fills = {item["fill"] for item in marks if item.get("fill")}
    fills.update(item["fill"] for item in merges if item.get("fill"))
    return {
        "fill": sorted(fills),
        "font": sorted({item["font"] for item in marks if item.get("font")}),
    }


def build_meta(
    wb: Workbook,
    model: WorkbookModel | None,
    *,
    source_name: str,
    sheets: list[str] | None = None,
) -> dict:
    palette = theme_palette(wb)
    wanted = set(sheets) if sheets else None
    locs = index_locs(model) if model is not None else {}
    marks: list[dict] = []
    merges: list[dict] = []
    for ws in wb.worksheets:
        if wanted is not None and ws.title not in wanted:
            continue
        facts, sheet_merges = collect_sheet(ws, palette)
        merges.extend(item.as_dict() for item in sheet_merges)
        for fact in facts.values():
            if not fact.is_mark():
                continue
            item = fact.as_dict()
            loc = locs.get((fact.sheet, fact.addr))
            if loc:
                item["loc"] = loc
            marks.append(item)
    marks.sort(key=lambda item: (item["sheet"], _addr_key(item["addr"])))
    merges.sort(key=lambda item: (item["sheet"], _addr_key(item["origin"])))
    return {"source": source_name, "colors": _colors(marks, merges), "marks": marks, "merges": merges}


def _addr_key(addr: str) -> tuple[int, int]:
    from openpyxl.utils import coordinate_to_tuple

    origin = addr.split(":", 1)[0]
    try:
        row, col = coordinate_to_tuple(origin)
    except (ValueError, TypeError):
        return 0, 0
    return row, col


def dump_meta(document: dict, path: str | Path) -> None:
    Path(path).write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
