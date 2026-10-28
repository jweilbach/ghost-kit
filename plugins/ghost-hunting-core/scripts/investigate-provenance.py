#!/usr/bin/env python3
"""Render investigation provenance from authenticated, resolved API records.

The server extracts entity URLs from raw Markdown, including link labels. HTML
entities preserve the visible title without introducing other raw URLs, code
spans or wikilinks. Only our validated destination remains literal.
"""
import argparse
import json
from pathlib import Path
from uuid import UUID


def label(title):
    if not isinstance(title, str) or not title.strip():
        raise ValueError("resolved record must have a nonempty title")
    text = " ".join(title.split())
    controls = set("&/\\`[]()*_!<>#|~")
    return "".join(f"&#{ord(char)};" if char in controls else char for char in text)


def render_provenance(ghost=None, augury=None):
    rows = []
    for record, prefix, path in (
        (ghost, "Investigated for", "ghosts"),
        (augury, "Augury in scope", "auguries"),
    ):
        if record is None:
            continue
        record_id = str(UUID(record["id"]))
        rows.append(f"**{prefix}:** [{label(record['title'])}](/{path}/{record_id})")
    return "\n".join(rows) + ("\n" if rows else "")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ghost", type=Path, help="successful Ghost response JSON")
    parser.add_argument("--augury", type=Path, help="successful Augury response JSON")
    args = parser.parse_args()
    try:
        records = [json.loads(path.read_text()) if path else None for path in (args.ghost, args.augury)]
        output = render_provenance(*records)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f"invalid investigation provenance: {error}\n")
    print(output, end="")


if __name__ == "__main__":
    main()
