import copy
import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/game-curator/scripts'
sys.path.insert(0, str(SCRIPTS))
import normalize
import validate


def capture(source, records, **changes):
    value = {'format':'game-curator-steam-export', 'version':1, 'source':source,
             'capturedAt':'2026-01-01T00:00:00Z', 'method':'fixture',
             'coverage':'partial', 'warnings':[], 'records':records}
    value.update(changes)
    return value


class ImportTests(unittest.TestCase):
    def test_library_fields_and_deduplication(self):
        row = {'appid': 10, 'name':'Synthetic', 'pageText':'TOTAL PLAYED 90 minutes LAST PLAYED Jan 21 ACHIEVEMENTS 3/10 4.6 GB'}
        result = normalize.normalize([capture('library', [row, row])])['captures'][0]
        self.assertEqual(result['recordCount'], 1)
        self.assertEqual(result['records'][0]['hours'], 1.5)
        self.assertEqual(result['records'][0]['lastPlayedDisplay'], 'Jan 21')
        self.assertEqual(result['records'][0]['achievements'], {'unlocked':3, 'total':10})
        self.assertTrue(result['warnings'])

    def test_missing_and_hours(self):
        data = capture('library', [{'appid':1,'pageText':'INSTALL SIZE 4.6 GB'}, {'appid':2,'pageText':'TOTAL PLAYED 0 hours'}, {'appid':3,'pageText':'TOTAL PLAYED 27.8 hours'}])
        rows = normalize.normalize([data])['captures'][0]['records']
        self.assertEqual([x['hours'] for x in rows], [None, 0, 27.8])
        self.assertIsNone(rows[0]['achievements'])

    def test_wishlist_missing_metadata_retained(self):
        result = normalize.normalize([capture('wishlist', [{'appid':5,'name':None,'lookupError':'failed'}])])
        self.assertEqual(result['captures'][0]['records'][0]['lookupError'], 'failed')

    def test_reviews_page_history_and_dedup(self):
        row = {'appid':7,'reviewUrl':'https://example.invalid/r/7','page':'1','pageText':'Synthetic review'}
        one = capture('reviews', [row, copy.deepcopy(row)])
        two = capture('reviews', [dict(row, page='2')], capturedAt='2026-02-01T00:00:00Z')
        result = normalize.normalize([two, one])
        self.assertEqual([c['recordCount'] for c in result['captures']], [1, 1])
        self.assertEqual(result['captures'][1]['records'][0]['page'], '2')

    def test_replay_keeps_percentages_and_unknown_year(self):
        row = {'year':None,'headings':['50% of playtime'],'apps':[{'appid':1}]}
        self.assertEqual(normalize.normalize([capture('replay',[row])])['captures'][0]['records'][0], row)

    def test_invalid_inputs_and_partial_empty(self):
        with self.assertRaises(ValueError): normalize.normalize([capture('library', [{'appid':'not-an-id'}])])
        with self.assertRaises(ValueError): normalize.normalize([capture('library', [], capturedAt='2026-01-01')])
        self.assertTrue(normalize.normalize([capture('library', [])])['captures'][0]['warnings'])

    def test_validation(self):
        valid = normalize.normalize([capture('wishlist',[{'appid':3}])])
        errors, warnings = validate.validate(valid)
        self.assertEqual(errors, [])
        self.assertTrue(warnings)
        valid['captures'][0]['recordCount'] = 3
        self.assertTrue(validate.validate(valid)[0])
        self.assertTrue(validate.validate({'version':2})[0])


if __name__ == '__main__':
    unittest.main()
