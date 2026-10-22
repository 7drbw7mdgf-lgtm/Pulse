"""Rule-bounded tables in PDF pages, read row by row instead of interleaving their cells.

Journal tables are usually drawn with full-width horizontal rules (above the header, below it
and at the end) and no vertical lines. Content between consecutive rules counts as tabular when
its lines hold several cells separated by gaps much wider than word spacing.
"""


def horizontal_rules(page):
    width, height = float(page.rect.width), float(page.rect.height)
    found = []
    for drawing in page.get_drawings():
        rect = drawing.get('rect')
        # Rules at the very top and bottom belong to running headers and footers.
        if rect is not None and rect.height <= 1.5 and rect.width >= width * .3 and height * .06 < rect.y0 < height * .94:
            found.append((rect.x0, rect.y0, rect.x1))
    rules = []
    for rule in sorted(found, key=lambda rule: rule[1]):
        if rules and abs(rules[-1][1] - rule[1]) < 1:
            rules[-1] = (min(rules[-1][0], rule[0]), rules[-1][1], max(rules[-1][2], rule[2]))
        else:
            rules.append(rule)
    return rules


def baseline_lines(words):
    lines = []
    for word in sorted(words, key=lambda word: ((word[1] + word[3]) / 2, word[0])):
        middle = (word[1] + word[3]) / 2
        if lines and abs(middle - lines[-1]['middle']) <= max(1.5, (word[3] - word[1]) * .4):
            lines[-1]['words'].append(word)
        else:
            lines.append({'middle': middle, 'words': [word]})
    for line in lines:
        line['words'].sort(key=lambda word: word[0])
    return lines


def wide_lines(lines):
    """Lines holding three or more cells, separated by gaps much wider than word spacing."""
    wide = 0
    for line in lines:
        size = max(word[3] - word[1] for word in line['words'])
        gaps = [b[0] - a[2] for a, b in zip(line['words'], line['words'][1:])]
        if sum(1 for gap in gaps if gap >= max(8, size * 1.1)) >= 2:
            wide += 1
    return wide


def tabular(lines):
    return wide_lines(lines) >= max(2, len(lines) * .25)


def column_cuts(lines, x0, x1):
    """Column boundaries where (almost) no line has a word, across the whole table."""
    covered = [0] * (int(x1 - x0) + 2)
    for line in lines:
        seen = set()
        for word in line['words']:
            seen.update(range(max(0, int(word[0] - x0)), min(len(covered), int(word[2] - x0) + 1)))
        for x in seen:
            covered[x] += 1
    allowed = len(lines) * .03
    cuts, start = [], None
    for x, count in enumerate(covered + [len(lines) + 1]):
        if count <= allowed and start is None:
            start = x
        elif count > allowed and start is not None:
            if x - start >= 4 and start > 0 and x < len(covered):
                cuts.append(x0 + (start + x) / 2)
            start = None
    return cuts


def table_rows(segments, x0, x1):
    lines = [line for _, _, rows in segments for line in rows]
    cuts = column_cuts(lines, x0, x1)
    def cells(words):
        values = [[] for _ in range(len(cuts) + 1)]
        for word in words:
            values[sum((word[0] + word[2]) / 2 >= cut for cut in cuts)].append(word[4])
        return [' '.join(value) for value in values]
    rows = []
    for index, (top, bottom, segment) in enumerate(segments):
        # The header between the first two rules is one row, however many lines it wraps to.
        header = index == 0 and len(segments) > 1 and len(segment) <= 4
        for line in segment:
            values = cells(line['words'])
            starts = values[0] and not values[0][0].islower() and not (len(values) > 1 and values[1][:1].islower())
            if rows and (header and rows[-1]['segment'] == index or not header and not starts and rows[-1]['segment'] == index):
                rows[-1]['cells'] = [' '.join(part for part in pair if part) for pair in zip(rows[-1]['cells'], values)]
                rows[-1]['bottom'] = max(word[3] for word in line['words'])
            else:
                rows.append({'segment': index, 'cells': values, 'top': min(word[1] for word in line['words']),
                             'bottom': max(word[3] for word in line['words']),
                             'size': max(word[3] - word[1] for word in line['words'])})
    return rows


def table_blocks(page, textpage=None):
    """Tables found on the page as blocks of row lines, for reading order and text extraction."""
    rules = horizontal_rules(page)
    if len(rules) < 2:
        return []
    words = page.get_text('words', textpage=textpage) if textpage is not None else page.get_text('words')
    tables, index = [], 0
    while index < len(rules) - 1:
        segments, current = [], index
        while current + 1 < len(rules):
            a, b = rules[current], rules[current + 1]
            x0, x1 = min(a[0], b[0]), max(a[2], b[2])
            if min(a[2], b[2]) - max(a[0], b[0]) < (x1 - x0) * .8:
                break
            inside = [word for word in words if a[1] < (word[1] + word[3]) / 2 < b[1] and x0 - 2 <= (word[0] + word[2]) / 2 <= x1 + 2]
            lines = baseline_lines(inside)
            # A short header (column titles that may wrap) counts when a table body follows it.
            header = not segments and lines and len(lines) <= 4 and wide_lines(lines) >= 1 and current + 2 < len(rules)
            if header:
                c = rules[current + 2]
                body = [word for word in words if b[1] < (word[1] + word[3]) / 2 < c[1] and x0 - 2 <= (word[0] + word[2]) / 2 <= x1 + 2]
                header = bool(body) and tabular(baseline_lines(body))
            if not lines or not (tabular(lines) or header):
                break
            segments.append((a[1], b[1], lines))
            current += 1
        if not segments:
            index += 1
            continue
        x0 = min(rules[i][0] for i in range(index, current + 1))
        x1 = max(rules[i][2] for i in range(index, current + 1))
        rows = table_rows(segments, x0, x1)
        top, bottom = segments[0][0], segments[-1][1]
        texts = [(row, ' | '.join(row['cells']).strip(' |')) for row in rows]
        block_rows = [((x0, row['top'], x1, row['bottom']), text, row['size']) for row, text in texts if text]
        if block_rows:
            sizes = {}
            for _, text, size in block_rows:
                sizes[round(size, 1)] = sizes.get(round(size, 1), 0) + len(text)
            tables.append({'box': (x0, top, x1, bottom), 'rows': block_rows, 'table': True,
                           'size': max(sizes, key=sizes.get), 'chars': sum(sizes.values())})
        index = current
    return tables
