import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
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

    def test_structured_library_fields_are_preserved(self):
        row = {'appid': 42, 'hours': 27.8, 'playtimeDisplay': '27.8 hours',
               'lastPlayedDisplay': 'Jan 21, 2024', 'achievements': {'unlocked': 18, 'total': 36}}
        result = normalize.normalize([capture('library', [row])])['captures'][0]['records'][0]
        for field in ('hours', 'playtimeDisplay', 'lastPlayedDisplay', 'achievements'):
            self.assertEqual(result[field], row[field])

    def test_invalid_semantic_values_are_reported_without_data_loss(self):
        row = {'appid': 42, 'hours': -1, 'achievements': {'unlocked': 4, 'total': 3}}
        result = normalize.normalize([capture('library', [row])])['captures'][0]
        self.assertEqual(result['records'][0]['hours'], -1)
        self.assertTrue(any('playtime' in warning for warning in result['warnings']))
        self.assertTrue(any('achievement' in warning for warning in result['warnings']))

    def test_distinct_accounts_refused_and_latest_view_is_additive(self):
        first = capture('library', [{'appid': 1, 'hours': 2}], account='local-account-a', batchId='one')
        second = capture('library', [{'appid': 2, 'hours': 4}], account='local-account-a', batchId='two', capturedAt='2026-02-01T00:00:00Z')
        archive = normalize.normalize([second, first])
        self.assertEqual({x['record']['appid'] for x in archive['latestObservations']}, {1, 2})
        self.assertEqual(len(archive['captures']), 2)
        second['account'] = 'local-account-b'
        with self.assertRaisesRegex(ValueError, 'cross-account'):
            normalize.normalize([first, second])

    def test_unknown_account_never_merged_into_latest_view(self):
        archive = normalize.normalize([capture('wishlist', [{'appid': 3}])])
        self.assertEqual(archive['latestObservations'], [])
        self.assertTrue(any('account' in warning for warning in archive['captures'][0]['warnings']))

    def test_historical_formats(self):
        for version in (2, 3):
            data = {'type':'library', 'schemaVersion':version, 'exportedAt':'2026-01-01T00:00:00Z',
                    'games':[{'appid':10,'hours':3}], 'expectedCount':2}
            result = normalize.normalize([data])['captures'][0]
            self.assertEqual(result['records'][0]['hours'], None if version == 2 else 3)
            self.assertEqual(result['originalExport'], data)
            self.assertTrue(any('differs' in warning for warning in result['warnings']))
        for version in (3, 4):
            data = {'type':'wishlist', 'schemaVersion':version, 'exportedAt':'2026-01-01T00:00:00Z', 'games':[{'appid':11,'rank':1}]}
            self.assertEqual(normalize.normalize([data])['captures'][0]['source'], 'wishlist')
        for version in (1, 2):
            data = {'format':'steam-review-export','version':version,'exportedAt':'2026-01-01T00:00:00Z', 'reviews':[{'appId':12,'gameName':'Synthetic','review':'Example'}]}
            self.assertEqual(normalize.normalize([data])['captures'][0]['records'][0]['appid'], 12)
        data = {'format':'steam-replay-export','version':1,'capturedAt':'2026-01-01T00:00:00Z','year':2025,'semanticBlocks':[{'text':'50%'}]}
        self.assertEqual(normalize.normalize([data])['captures'][0]['records'][0]['semanticBlocks'][0]['text'], '50%')

    def test_legacy_v2_reparses_and_preserves_evidence(self):
        data = {'type':'library', 'schemaVersion':2, 'exportedAt':'2026-01-01T00:00:00Z',
                'playtimeMayIncludeIdling':True, 'games':[
                    {'appid':1, 'hours':500, 'pageText':'TOTAL PLAYED 45 minutes'},
                    {'appid':2, 'hours':500, 'pageText':'DOWNLOAD 12 GB'},
                    {'appid':3, 'hours':12},
                    {'appid':4, 'hours':0, 'pageText':'TOTAL PLAYED 0 hours'}]}
        capture_result = normalize.normalize([data])['captures'][0]
        records = capture_result['records']
        self.assertEqual([r['hours'] for r in records], [0.75, None, None, 0])
        self.assertEqual(records[0]['raw']['hours'], 500)
        self.assertEqual(capture_result['originalExport'], data)
        self.assertEqual(sum('conflicts' in w for w in capture_result['warnings']), 2)
        self.assertTrue(any('unverified' in w for w in capture_result['warnings']))
        self.assertTrue(any('idling' in w for w in capture_result['warnings']))

    def test_explicit_account_and_batch_association(self):
        legacy = {'type':'library', 'schemaVersion':3, 'exportedAt':'2026-01-01T00:00:00Z',
                  'games':[{'appid':1,'hours':8}], 'user':'synthetic-identity'}
        newer = capture('library', [{'appid':1,'hours':None}], capturedAt='2026-02-01T00:00:00Z')
        result = normalize.normalize([legacy, newer], account='personal', batch_id='capture-1')
        self.assertEqual([c['account'] for c in result['captures']], ['personal','personal'])
        view = result['latestObservations'][0]
        self.assertEqual(view['batchId'], 'capture-1')
        self.assertIsNone(view['record']['hours'])
        self.assertEqual(view['previousObservations'][0]['record']['hours'], 8)
        self.assertNotIn('account', legacy)
        with self.assertRaisesRegex(ValueError, 'conflicts'):
            normalize.normalize([capture('wishlist', [], account='other')], account='personal')
        with self.assertRaisesRegex(ValueError, 'conflicts'):
            normalize.normalize([capture('wishlist', [], account='personal', batchId='other')], account='personal', batch_id='one')
        with self.assertRaisesRegex(ValueError, 'requires'):
            normalize.normalize([legacy], batch_id='one')
        different = dict(legacy, user='different-synthetic-identity')
        with self.assertRaisesRegex(ValueError, 'conflicting historical'):
            normalize.normalize([legacy, different], account='personal')

    def test_cli_account_association(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'input.json'
            output = Path(directory) / 'output.json'
            source.write_text(json.dumps(capture('wishlist', [{'appid':1}])))
            subprocess.run([sys.executable, str(SCRIPTS / 'normalize.py'), str(source),
                            '--account', 'test-alias', '--batch-id', 'test-batch',
                            '--output', str(output)], check=True, capture_output=True, text=True)
            result = json.loads(output.read_text())
            self.assertEqual(result['latestObservations'][0]['account'], 'test-alias')
            self.assertEqual(result['latestObservations'][0]['batchId'], 'test-batch')


if __name__ == '__main__':
    unittest.main()
