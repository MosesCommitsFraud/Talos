"""Keep Markdown/Docling table headers with their row chunks."""


def rows_markdown(rows):
    """Render rectangular table values without requiring a second table parser."""
    rows = list(rows)
    if not rows:
        return ""
    width = max(map(len, rows))

    def line(row):
        cells = [
            str(cell).replace("\\", "\\\\").replace("|", "\\|").replace("\n", "<br>")
            for cell in row
        ]
        return "| " + " | ".join(cells + [""] * (width - len(cells))) + " |\n"

    return line(rows[0]) + line(["---"] * width) + "".join(line(row) for row in rows[1:])


def table_units(text):
    """Yield (start, end, is_table), respecting Markdown code fences."""
    from markdown_it import MarkdownIt

    offsets = [0]
    for line in text.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    cursor = 0
    for token in MarkdownIt().enable("table").parse(text):
        if token.type != "table_open" or not token.map:
            continue
        start, end = (offsets[i] for i in token.map)
        if start > cursor:
            yield cursor, start, False
        yield start, end, True
        cursor = end
    if cursor < len(text):
        yield cursor, len(text), False


def table_parts(text, limit):
    """Yield text, source start/end and number of synthetic header characters.

    Very long rows are continued without dropping cells. A header too large to
    leave room for even one character is split losslessly without repetition.
    """
    lines = text.splitlines(keepends=True)
    header = "".join(lines[:2])
    if len(header) >= limit or len(lines) <= 2:
        for start in range(0, len(text), limit):
            end = min(start + limit, len(text))
            yield text[start:end], start, end, 0
        return
    start = 0
    end = len(header)
    body = header
    prefix = 0
    for line in lines[2:]:
        while line:
            if len(body) + len(line) > limit and len(body) > len(header):
                yield body, start, end, prefix
                start = end
                body, prefix = header, len(header)
            capacity = limit - len(body)
            take = min(capacity, len(line))
            body += line[:take]
            end += take
            line = line[take:]
            if line:
                yield body, start, end, prefix
                start = end
                body, prefix = header, len(header)
    if end > start:
        yield body, start, end, prefix
