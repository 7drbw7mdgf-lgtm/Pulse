"""index.html must stay well nested: one unclosed <div> hides every later section inside it."""
from html.parser import HTMLParser
from pathlib import Path
import unittest

INDEX = Path(__file__).resolve().parents[1] / 'pulse-frontend' / 'index.html'
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}


class _Nesting(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.mismatches = [], []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append((tag, self.getpos()))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()
        else:
            self.mismatches.append((tag, self.getpos()))


class IndexMarkupTests(unittest.TestCase):
    def test_every_element_is_closed_in_order(self):
        parser = _Nesting()
        parser.feed(INDEX.read_text(encoding='utf-8'))
        parser.close()
        self.assertEqual(parser.mismatches, [], 'closing tags out of order (line, column)')
        self.assertEqual(parser.stack, [], 'elements left open (line, column)')

    def test_element_ids_are_unique(self):
        import collections, re
        ids = collections.Counter(re.findall(r'\bid="([^"]+)"', INDEX.read_text(encoding='utf-8')))
        self.assertEqual({key: count for key, count in ids.items() if count > 1}, {}, 'duplicate IDs (e.g. a section merged twice)')


if __name__ == '__main__':
    unittest.main()
