import csv
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'skills/book-curator/scripts/goodreads_csv.py'
spec = importlib.util.spec_from_file_location('goodreads', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def make_csv(rows):
    out = io.StringIO(newline='')
    writer = csv.writer(out)
    writer.writerows(rows)
    return io.StringIO(out.getvalue(), newline='')

class ImportTests(unittest.TestCase):
    def test_quotes_newlines_and_missing_values(self):
        source = make_csv([['Book Id','Title','Author','ISBN13','My Rating','My Review','Exclusive Shelf'],
                           ['12','A, Book','A. Writer','="9780000000000"','0','Great,\nbut long','read'],
                           ['13','A, Book','Another Writer','','5','','to-read']])
        result = module.normalize(source, '2026-01-01T00:00:00Z')
        a,b = result['records']
        self.assertEqual(a['review'], 'Great,\nbut long')
        self.assertEqual(a['isbn13'], '9780000000000')
        self.assertIsNone(a['rating'])
        self.assertEqual(a['original']['My Rating'], '0')
        self.assertEqual(b['rating'], 5)
        self.assertEqual(len(result['records']), 2)  # Similar titles remain distinct.
        self.assertEqual(result['coverage'], 'unknown')
        self.assertIsNone(result['exportedAt'])

    def test_invalid_input_and_rating(self):
        with self.assertRaises(ValueError): module.normalize(make_csv([['Title'], ['X']]))
        with self.assertRaises(ValueError): module.normalize(make_csv([['Book Id','Title'], ['1','X','extra']]))
        result = module.normalize(make_csv([['Book Id','Title','My Rating'],['1','X','7']]))
        self.assertIsNone(result['records'][0]['rating'])
        self.assertEqual(result['records'][0]['original']['My Rating'], '7')
        self.assertGreater(len(result['warnings']), 1)

    def test_cli_wont_overwrite_existing_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            src, dest = Path(folder)/'in.csv', Path(folder)/'out.json'
            src.write_text('Book Id,Title\n1,Example\n')
            dest.write_text('keep')
            process = subprocess.run([sys.executable,str(SCRIPT),str(src),str(dest)], capture_output=True)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(dest.read_text(), 'keep')
            dest.unlink()
            subprocess.run([sys.executable,str(SCRIPT),str(src),str(dest)], check=True)
            self.assertEqual(json.loads(dest.read_text())['records'][0]['title'], 'Example')

if __name__ == '__main__': unittest.main()
