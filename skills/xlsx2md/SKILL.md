---
name: xlsx2md
description: >-
  Convert messy Excel (.xlsx/.xlsm) to readable Markdown with the xlsx2md CLI
  (densify merges and empty columns, then markitdown), write a JSON sidecar of
  fills, font colors, comments, and merges, and diff two workbooks. Use when
  the user asks to convert Excel to Markdown, đọc xlsx thành md, dump a
  画面設計書 / 帳票設計書 for an LLM, compare two Excel versions, or when
  markitdown / pandas.read_excel yields Unnamed: or | NaN | tables. Prefer
  xlsx2md over raw markitdown for sparse or merged workbooks.
---

# xlsx2md

CLI at `/home/vietis/Projects/xlsx2md`. Binary: `xlsx2md` (mise Python). It is **geometry plus raw cell facts**, not a BSN parser: no sheet-name or palette special cases.

Vanilla `markitdown file.xlsx` is `pandas.read_excel` (row 1 = header) → HTML → Markdown. Inflated used-range + merges become `Unnamed:` / `| NaN |`. This CLI densifies first, then uses the same HTML converter. Colors, comments, and merges that Markdown cannot carry go to a JSON sidecar.

## Default

```bash
xlsx2md "$FILE" -o "${FILE%.xlsx}.md" --meta "${FILE%.xlsx}.meta.json"
```

Quote paths. Japanese filenames are normal. Completion: the `.md` and the `.meta.json` exist, stderr lists every sheet as `N×M` or `outline` plus `N marks, N merges`, and the Markdown has no `Unnamed:` and no `| NaN |`.

Print both paths and the stderr stats. Do not paste the Markdown or the JSON into chat.

If `xlsx2md` is missing:

```bash
python3 -m pip install -e '/home/vietis/Projects/xlsx2md'
```

`xlsx2md --help` and `xlsx2md diff --help` are authoritative for flags.

## Two workbooks

Convert each file with `--meta`, then diff. The diff is the change list; each sidecar is that file's full color, comment, and merge map.

```bash
xlsx2md diff "$OLD" "$NEW" -o diff.md --meta diff.meta.json
```

Completion: `diff.md` and `diff.meta.json` exist, stderr is `xlsx2md diff: N change(s)`. A workbook whose path is the literal name `diff` is passed as `./diff`.

## Sidecar

`--meta` writes one JSON object:

| Field | Meaning |
|---|---|
| `colors.fill` / `colors.font` | Distinct 6-digit hex values on marks and on merges |
| `marks[]` | Cell with a non-white fill, a non-black font, strike, bold, or a comment. Plain text with none of those stays in the Markdown only. An empty fill-only cell is omitted; its fill stays on `merges[]` when it is a merge origin |
| `marks[].text` | Plain cell value. Strike is `strike: true`, not `~~` |
| `marks[].fill` | Background hex. White is omitted |
| `marks[].font` | Font hex. Black and theme-black are omitted |
| `marks[].comment` | Comment text. The Sheets author/date wrapper is already stripped |
| `marks[].merge` | Merge range when this cell is the origin, such as `E2:G2` |
| `marks[].loc` | Where densify placed the cell in the Markdown |
| `merges[]` | Every merge: `range`, `origin`, `rows`, `cols`, `text`, and `fill` when the origin has one |

`loc.role` is `cell`, `header`, `pair`, `intro`, `meta`, `outline`, or `banner`. `loc.section` is the `##` heading. `loc.header` is the flattened column name. `loc.row` is the 1-based body row inside that table chunk. `loc.banner` is the `**heading**` above the chunk. `loc.key` is the meta or pair label.

Theme colors are resolved to hex (Excel's theme index, including tint). A shared merge parent points at the first flattened header. No `loc` means densify did not emit that cell; `addr` is still the Excel cell.

Diff JSON `changes[]` uses `kind`: `added`, `removed`, `changed`, `merge_added`, `merge_removed`, `sheet_added`, `sheet_removed`. `changed.fields` is `{name: [old, new]}` for `text`, `fill`, `font`, `strike`, `bold`, `comment`. `loc` is the cell's place in the workbook that still contains it.

## Flags

| Flag | When |
|---|---|
| `-o PATH` | Always, unless the user asked for stdout |
| `--sheet NAME` | Repeatable. One sheet (or a few), not the whole book |
| `-q` | Quiet stderr after you already have stats |
| `--no-markup` | Plain cell text: no `~~strike~~`, no comment `( )` |
| `--meta PATH` | JSON sidecar of fills, fonts, comments, merges, and `loc` |
| `--keep-xlsx PATH` | Dense workbook for pandas |
| `--raw` | Skip preprocess. Only to compare against vanilla markitdown |
| `diff OLD NEW` | Text and fact diff. Same `--meta`, `--sheet`, `-o`, `-q` |

## What the Markdown looks like

- `#` filename, then `##` per sheet.
- Repeated filled-label + value pairs across sheets → one `## meta` table (`システム`, `機能ID`, …). Those pairs are stripped from individual sheets.
- **Dense** sheets (item lists, checks, history) → GitHub tables. Merged sub-headers flatten (`桁数` + `整数` → `桁数/整数`). A one-cell row that is followed by multi-cell data is a section heading (`**実行ボタン**`), then a table.
- **Sparse** sheets (cover, layout, 詳細設計 FE/BE/API) → indented outline. Numbered 3+ column blocks inside the outline become nested tables (JOIN, Request Body).
- Strikethrough → `~~text~~`. Comments in body cells stay in `( )`. Header comments are not in the Markdown; they are in the sidecar.

Read only the `##` sections and sidecar records the current task needs. For a color, comment, merge, or edit, the sidecar is the source. The `( )` and `~~ ~~` in Markdown are the same facts folded into the cell text.

## Choose the tool

| Goal | Tool |
|---|---|
| Markdown / LLM context from a messy xlsx, plus where the colors, comments, and merges went | **xlsx2md** `--meta` |
| What changed between two xlsx files | **xlsx2md** `diff` |
| Editing the xlsx, or a live layout you must click through | `officecli` (officecli-xlsx) |
| What a BSN 変更/削除 color means (blue / red+strike) as a spec rule | `bsn-detail-spec`. xlsx2md records the hex, strike, and comment; it does not name the rule. |

## Guardrails

- Run the CLI. Do not reimplement densify in a notebook, and do not `pandas.read_excel` the original file for LLM context.
- Do not add sheet-name or Japanese-keyword branches around the CLI.
- `--raw` is a comparison switch, not the default for 画面設計書.
