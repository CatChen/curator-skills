import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(__file__), '..', '..', 'skills', 'book-curator', 'scripts', 'amazon_snapshot.py')


def snapshot(records=None, **extra):
    records = records if records is not None else [
        {'sourceId': 'S1', 'sourceType': 'KindleEBook', 'category': 'books', 'title': 'Synthetic One', 'author': 'A', 'dateLabel': 'd'},
        {'sourceId': 'S2', 'sourceType': 'KindleEBookSample', 'category': 'books', 'title': 'Synthetic Two', 'author': 'B', 'dateLabel': 'd'}]
    value = {'format': 'book-curator-amazon-content', 'version': 1, 'category': 'books', 'capturedAt': '2000-01-01T00:00:00.000Z',
             'method': 'read-only-dom-pagination', 'coverage': 'complete-observed', 'warnings': [],
             'diagnostics': {'displayedTotal': len(records)}, 'records': records}
    value.update(extra)
    return value


class AmazonSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def write(self, name, value):
        path = os.path.join(self.dir.name, name)
        data = (json.dumps(value) + '\n').encode()
        with open(path, 'wb') as handle:
            handle.write(data)
        return path, hashlib.sha256(data).hexdigest()

    def run_script(self, *args):
        return subprocess.run([sys.executable, '-I', SCRIPT, *args], capture_output=True, text=True)

    def evidence(self, path, digest, **override):
        sidecar = {'version': 1, 'snapshot': os.path.basename(path), 'sha256': digest, 'category': 'books',
                   'capturedAt': '2000-01-01T00:00:00.000Z', 'accountAlias': 'test-alias'}
        sidecar.update(override)
        self.write(os.path.basename(path) + '.evidence.json', sidecar)

    def test_summary_is_historical_and_prints_no_record_text(self):
        path, digest = self.write('books-x.json', snapshot())
        self.evidence(path, digest)
        before = open(path, 'rb').read()
        result = self.run_script(path)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['recordCount'], 2)
        self.assertEqual(report['sourceTypes'], {'KindleEBook': 1, 'KindleEBookSample': 1})
        self.assertTrue(report['isHistorical'])
        self.assertTrue(all(report['evidenceChecks'].values()))
        self.assertIn('test-alias', report['identity'])
        self.assertEqual(report['problems'], [])
        self.assertNotIn('Synthetic', result.stdout)
        self.assertNotIn('S1', result.stdout)
        self.assertEqual(open(path, 'rb').read(), before)
        self.assertEqual(sorted(os.listdir(self.dir.name)), ['books-x.json', 'books-x.json.evidence.json'])

    def test_missing_or_mismatched_evidence_means_unknown_identity(self):
        path, digest = self.write('books-y.json', snapshot())
        self.assertIn('unknown', json.loads(self.run_script(path).stdout)['identity'])
        self.evidence(path, 'f' * 64)
        report = json.loads(self.run_script(path).stdout)
        self.assertIn('unknown', report['identity'])
        self.assertFalse(report['evidenceChecks']['digestMatches'])
        self.assertIn('evidence sidecar mismatch', report['problems'])
        self.assertNotIn('test-alias', report['identity'])

    def test_flags_duplicates_and_total_mismatch_and_rejects_other_formats(self):
        dup = [{'sourceId': 'S1', 'sourceType': 'KindleEBook'}, {'sourceId': 'S1', 'sourceType': 'KindleEBook'}]
        path, _ = self.write('books-z.json', snapshot(dup, diagnostics={'displayedTotal': 3}))
        report = json.loads(self.run_script(path).stdout)
        self.assertIn('duplicate or missing source identifiers', report['problems'])
        self.assertIn('record count differs from displayed total', report['problems'])
        other, _ = self.write('other.json', {'format': 'something-else'})
        result = self.run_script(other)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.run_script().returncode, 2)


if __name__ == '__main__':
    unittest.main()
