"""CLI: densify Excel, then convert with markitdown."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .convert import convert_path, format_stats


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="xlsx2md",
        description=(
            "Convert Excel to Markdown. Unmerges and drops empty rows/columns "
            "so markitdown is not fed a NaN grid (pandas header=row 1). "
            "`xlsx2md diff OLD NEW` compares two workbooks."
        ),
    )
    parser.add_argument("input", help="Path to .xlsx / .xlsm")
    parser.add_argument("-o", "--output", help="Write Markdown here. Default: stdout.")
    parser.add_argument(
        "--sheet",
        action="append",
        dest="sheets",
        metavar="NAME",
        help="Only convert this sheet (repeatable).",
    )
    parser.add_argument(
        "--raw",
        action="store_true",
        help="Skip preprocess; call markitdown on the file as-is.",
    )
    parser.add_argument(
        "--keep-xlsx",
        metavar="PATH",
        help="Write the dense preprocessed workbook.",
    )
    parser.add_argument(
        "--no-markup",
        action="store_true",
        help="Do not keep strikethrough/comments in cell text.",
    )
    parser.add_argument(
        "--meta",
        metavar="PATH",
        help="Write JSON of fills, font colors, comments, merges, and Markdown locations.",
    )
    parser.add_argument("-q", "--quiet", action="store_true", help="No stats on stderr.")
    parser.add_argument("-V", "--version", action="version", version=f"xlsx2md {__version__}")
    return parser


def build_diff_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="xlsx2md diff",
        description="Compare two workbooks: text, fill, font color, strike, bold, comment, and merges.",
    )
    parser.add_argument("base", help="Older .xlsx / .xlsm")
    parser.add_argument("other", help="Newer .xlsx / .xlsm")
    parser.add_argument("-o", "--output", help="Write the diff Markdown here. Default: stdout.")
    parser.add_argument("--meta", metavar="PATH", help="Write the diff as JSON.")
    parser.add_argument(
        "--sheet",
        action="append",
        dest="sheets",
        metavar="NAME",
        help="Only compare this sheet (repeatable).",
    )
    parser.add_argument("-q", "--quiet", action="store_true", help="No stats on stderr.")
    return parser


def _missing(path: Path) -> int:
    print(f"xlsx2md: file not found: {path}", file=sys.stderr)
    return 2


def _write(text: str, output: str | None) -> None:
    if output:
        Path(output).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)


def _diff_main(argv: list[str]) -> int:
    from .diff import diff_paths, dump_diff

    args = build_diff_parser().parse_args(argv)
    base = Path(args.base)
    other = Path(args.other)
    if not base.is_file():
        return _missing(base)
    if not other.is_file():
        return _missing(other)
    markdown, document, count = diff_paths(base, other, sheets=args.sheets)
    if args.meta:
        dump_diff(document, args.meta)
    if not args.quiet:
        print(f"xlsx2md diff: {count} change(s)", file=sys.stderr)
    _write(markdown, args.output)
    return 0


def main(argv: list[str] | None = None) -> int:
    args_in = list(sys.argv[1:] if argv is None else argv)
    if args_in and args_in[0] == "diff":
        return _diff_main(args_in[1:])

    args = build_parser().parse_args(args_in)
    source = Path(args.input)
    if not source.is_file():
        return _missing(source)

    info: dict = {}
    markdown, model = convert_path(
        source,
        sheets=args.sheets,
        markup=not args.no_markup,
        raw=args.raw,
        keep_xlsx=args.keep_xlsx,
        meta=args.meta,
        meta_info=info,
    )
    if not args.quiet:
        print(format_stats(model, raw=args.raw), file=sys.stderr)
        if args.meta:
            print(
                f"xlsx2md: meta {info.get('marks', 0)} marks, {info.get('merges', 0)} merges",
                file=sys.stderr,
            )
    _write(markdown, args.output)
    return 0
