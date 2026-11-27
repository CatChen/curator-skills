import csv
import importlib.util
import io
import json
import os
import stat
from unittest import mock
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
        self.assertIsNone(result['observedAt'])
        self.assertEqual(result['processedAt'], '2026-01-01T00:00:00Z')
        self.assertEqual(result['method'], 'local-csv-normalization')

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
            self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o600)

    def test_decimal_ratings_from_export(self):
        data = make_csv([['Book Id', 'Title', 'My Rating'], ['1', 'A', '4.0'],
                         ['2', 'B', '0.0'], ['3', 'C', 'NaN']])
        result = module.normalize(data)
        self.assertEqual([x['rating'] for x in result['records']], [4.0, None, None])
        self.assertEqual(result['records'][0]['original']['My Rating'], '4.0')
        self.assertTrue(any('invalid rating' in w for w in result['warnings']))

    def test_id_conflicts_are_reported_without_dropping_records(self):
        data = make_csv([['Book Id','Title','Author'], ['', 'Unknown', 'A'],
                         ['1','First','A'], ['1','Different','B']])
        result = module.normalize(data)
        self.assertEqual(len(result['records']), 3)
        self.assertTrue(any('missing Goodreads book ID' in x for x in result['warnings']))
        self.assertTrue(any('conflicting metadata' in x for x in result['warnings']))

    def test_failed_write_is_removed_but_existing_output_survives(self):
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder) / 'output.json'
            with mock.patch.object(module.os, 'fsync', side_effect=OSError('failure')):
                with self.assertRaises(OSError): module.write_private_output(dest, {'private': 'data'})
            self.assertFalse(dest.exists())
            dest.write_text('existing')
            with self.assertRaises(FileExistsError): module.write_private_output(dest, {})
            self.assertEqual(dest.read_text(), 'existing')

    def test_failed_readback_is_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder) / 'output.json'
            original = module.os.fdopen
            class CorruptRead:
                def __init__(self, wrapped): self.wrapped = wrapped
                def __enter__(self): self.wrapped.__enter__(); return self
                def __exit__(self, *args): return self.wrapped.__exit__(*args)
                def __getattr__(self, name): return getattr(self.wrapped, name)
                def read(self): return b'corrupt'
            with mock.patch.object(module.os, 'fdopen', side_effect=lambda *a, **kw: CorruptRead(original(*a, **kw))):
                with self.assertRaises(OSError): module.write_private_output(dest, {'a': 1})
            self.assertFalse(dest.exists())


class MinimizationTests(unittest.TestCase):
    def test_private_columns_are_not_retained(self):
        source = make_csv([['Book Id','Title','My Rating','Private Notes','Recommended By','Original Purchase Location','Read Count','Owned Copies'],
                           ['1','X','4','SYNTHETIC-PRIVATE','SYNTHETIC-PERSON','SYNTHETIC-STORE','2','1']])
        result = module.normalize(source, '2026-01-01T00:00:00Z')
        dumped = json.dumps(result)
        for secret in ('SYNTHETIC-PRIVATE', 'SYNTHETIC-PERSON', 'SYNTHETIC-STORE'):
            self.assertNotIn(secret, dumped)
        original = result['records'][0]['original']
        self.assertEqual(original['My Rating'], '4')
        self.assertEqual((original['Read Count'], original['Owned Copies']), ('2', '1'))
        self.assertIn('3 export columns', result['warnings'][1])


if __name__ == '__main__': unittest.main()
