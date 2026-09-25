# xlsx2md

Preprocess Excel into a dense grid, then convert with [markitdown](https://github.com/microsoft/markitdown).

`markitdown file.xlsx` is `pandas.read_excel` → HTML → Markdown. That treats row 1 as the header and keeps Excel’s inflated used-range, so merged/sparse sheets become `Unnamed:` / `NaN` tables. This CLI only fixes that geometry, then uses the same markitdown HTML converter.

## Install

```bash
python3 -m pip install -e .
```

## Usage

```bash
xlsx2md file.xlsx -o file.md --meta file.meta.json
xlsx2md file.xlsx --sheet Sheet1
xlsx2md file.xlsx --keep-xlsx dense.xlsx   # pandas-friendly xlsx
xlsx2md file.xlsx --raw                    # markitdown with no preprocess
xlsx2md file.xlsx --no-markup              # drop strikethrough / comments
xlsx2md diff old.xlsx new.xlsx -o diff.md --meta diff.meta.json
```

## What it does (per sheet)

1. Read cells that actually have values (ignore the 1000×N used-range).
2. Keep merge origins only, then drop empty columns.
3. Typical row width (the common width, not the banner) picks the header band; filled+unfilled pairs become workbook `meta` when they repeat.
4. Flatten merged sub-headers (`Digits` + `int` → `Digits/int`).
5. Sparse sheets (low occupancy) render as an indented outline, not a hollow table.
6. Strikethrough → `~~text~~`; comments stay in parentheses.
7. Dense tables go through markitdown’s HTML converter (`DataFrame.to_html(na_rep="")`).
8. `--meta` writes fills, font colors, strike, bold, comments, and merges, each with the Markdown location (`loc`). White fill and black font are omitted. `xlsx2md diff` compares two workbooks on those same facts plus cell text.

No sheet-name or palette special cases. The sidecar records the color value; it does not name what a color means.
