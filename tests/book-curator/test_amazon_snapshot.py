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
                   'capturedAt': '2000-01-01T00:00:00.000Z', 'accountAlias': 'test-alias',
                   'accountIdentity': 'user-confirmed intended account', 'accountVerification': 'user confirmed before capture'}
        sidecar.update(override)
        self.write(os.path.basename(path) + '.evidence.json', sidecar)

    def report(self, name, value, **override):
        path, digest = self.write(name, value)
        self.evidence(path, digest, **override)
        result = self.run_script(path)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout), result.stdout

    def test_summary_is_counts_only_and_never_writes(self):
        path, digest = self.write('books-x.json', snapshot(warnings=['Private warning text']))
        self.evidence(path, digest)
        before = open(path, 'rb').read()
        result = self.run_script(path)
        report = json.loads(result.stdout)
        self.assertEqual(report['recordCount'], 2)
        self.assertEqual(report['sourceTypes'], {'KindleEBook': 1, 'KindleEBookSample': 1, 'KindlePDoc': 0})
        self.assertTrue(report['isHistorical'])
        self.assertTrue(all(report['evidenceAssociation'].values()))
        self.assertEqual((report['identity'], report['problems'], report['snapshotWarningCount']), ('recorded', [], 1))
        for private in ('Synthetic', 'S1', 'test-alias', 'Private warning', 'user confirmed'):
            self.assertNotIn(private, result.stdout)
        self.assertEqual(open(path, 'rb').read(), before)
        self.assertEqual(sorted(os.listdir(self.dir.name)), ['books-x.json', 'books-x.json.evidence.json'])

    def test_matching_association_without_verified_identity_stays_unknown(self):
        for name, override in [('null-alias', {'accountAlias': None}), ('no-alias', {'accountAlias': ''}),
                               ('no-verification', {'accountVerification': None}),
                               ('unverified', {'accountIdentity': 'unverified account'})]:
            report, _ = self.report(f'books-{name}.json', snapshot(), **override)
            self.assertTrue(all(report['evidenceAssociation'].values()), name)
            self.assertEqual(report['identity'], 'unknown', name)
            self.assertEqual(report['problems'], [], name)

    def test_missing_or_mismatched_sidecar_means_unknown_identity(self):
        path, digest = self.write('books-y.json', snapshot())
        report = json.loads(self.run_script(path).stdout)
        self.assertEqual((report['identity'], report['identityReason']), ('unknown', 'no-sidecar'))
        self.evidence(path, 'f' * 64)
        report = json.loads(self.run_script(path).stdout)
        self.assertEqual(report['identity'], 'unknown')
        self.assertFalse(report['evidenceAssociation']['digestMatches'])
        self.assertIn('evidence sidecar mismatch', report['problems'])

    def test_malformed_inputs_are_handled_safely(self):
        path, digest = self.write('books-m.json', snapshot(
            ['text', 3, None, {'sourceId': 7, 'sourceType': 'KindleEBook'}, {'sourceId': 'S9', 'sourceType': 'Other'},
             {'sourceId': 'S1', 'sourceType': 'KindleEBook'}, {'sourceId': 'S1', 'sourceType': 'KindleEBook'}, {'sourceType': 'KindlePDoc'}],
            warnings='not-a-list', diagnostics={'displayedTotal': True}))
        self.write('books-m.json.evidence.json', ['not', 'an', 'object'])
        result = self.run_script(path)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual((report['malformedRecords'], report['unsupportedSourceTypes']), (3, 1))
        self.assertEqual(report['missingIds'], 3)
        self.assertEqual(report['identity'], 'unknown')
        self.assertIsNone(report['snapshotWarningCount'])
        self.assertIsNone(report['displayedTotal'])
        for expected in ('malformed records', 'duplicate source identifiers', 'evidence sidecar is not an object'):
            self.assertIn(expected, report['problems'])
        unreadable, _ = self.write('books-u.json', snapshot())
        open(unreadable + '.evidence.json', 'w').write('{broken')
        self.assertIn('evidence sidecar unreadable', json.loads(self.run_script(unreadable).stdout)['problems'])

    def test_rejects_other_formats_and_bad_usage_without_echoing_content(self):
        other, _ = self.write('other.json', {'format': 'something-else', 'secret': 'Synthetic'})
        result = self.run_script(other)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('Synthetic', result.stderr)
        self.assertEqual(self.run_script().returncode, 2)
        self.assertEqual(self.run_script(other, '--evidence').returncode, 2)


if __name__ == '__main__':
    unittest.main()
