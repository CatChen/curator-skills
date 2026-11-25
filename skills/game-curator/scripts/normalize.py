#!/usr/bin/env python3
"""Normalize version 1 Steam captures without discarding historical observations."""
import argparse
import datetime
import json
import math
import re
import sys
from pathlib import Path

SOURCES = {'library', 'wishlist', 'reviews', 'replay'}


def adapt_legacy(data):
    """Adapt recognized historical schemas; preserve the source object in the archive."""
    if not isinstance(data, dict):
        return data
    source, rows = None, None
    if data.get('type') == 'library' and data.get('schemaVersion') in (2, 3):
        source, rows = 'library', data.get('games')
    elif data.get('type') == 'wishlist' and data.get('schemaVersion') in (3, 4):
        source, rows = 'wishlist', data.get('games')
    elif data.get('format') == 'steam-review-export' and data.get('version') in (1, 2):
        source, rows = 'reviews', data.get('reviews')
    elif data.get('format') == 'steam-replay-export' and data.get('version') == 1:
        source, rows = 'replay', [{k: data.get(k) for k in ('year', 'headings', 'apps', 'semanticBlocks', 'page')}]
    if source is None:
        return data
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError('malformed historical records')
    if source == 'reviews':
        rows = [dict(row, appid=row.get('appId'), name=row.get('gameName')) for row in rows]
    stamp = data.get('exportedAt') or data.get('capturedAt')
    warnings = ['historical export; source identity and completeness require verification']
    expected = data.get('expectedCount', data.get('expectedReviewCount'))
    if isinstance(expected, int) and expected != len(rows):
        warnings.append(f'displayed expected count {expected} differs from {len(rows)} collected records')
    if data.get('possiblyIncomplete'):
        warnings.append('historical export reports possible incompleteness')
    if data.get('playtimeMayIncludeIdling'):
        warnings.append('reported playtime may include idling and may not reflect meaningful gameplay')
    return {'format':'game-curator-steam-export', 'version':1, 'source':source,
            'capturedAt':stamp, 'method':'historical-import', 'coverage':'unknown',
            'warnings':warnings, 'records':rows, 'originalExport':data,
            'account': data.get('account'), 'batchId': data.get('batchId')}


def check_export(data):
    errors = []
    if not isinstance(data, dict):
        return ['export must be an object']
    if data.get('format') != 'game-curator-steam-export' or data.get('version') != 1:
        errors.append('unsupported export format or version')
    if data.get('source') not in SOURCES:
        errors.append('invalid source')
    try:
        stamp = datetime.datetime.fromisoformat(data.get('capturedAt', '').replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError('timezone required')
    except (ValueError, TypeError, AttributeError):
        errors.append('capturedAt must be an ISO timestamp with timezone')
    if not isinstance(data.get('method'), str) or not data['method']:
        errors.append('method must be a nonempty string')
    if data.get('coverage') not in ('complete', 'partial', 'unknown'):
        errors.append('invalid coverage')
    if not isinstance(data.get('warnings'), list) or not all(isinstance(x, str) for x in data['warnings']):
        errors.append('warnings must be a list of strings')
    if not isinstance(data.get('records'), list) or not all(isinstance(x, dict) for x in data['records']):
        errors.append('records must be a list of objects')
    elif data.get('source') in {'library', 'wishlist', 'reviews'}:
        for i, record in enumerate(data['records']):
            appid = record.get('appid')
            if not isinstance(appid, int) or isinstance(appid, bool) or appid <= 0:
                errors.append(f'record {i}: appid must be a positive integer')
    for field in ('account', 'batchId'):
        if data.get(field) is not None and (not isinstance(data[field], str) or not data[field].strip()):
            errors.append(f'{field} must be a nonempty string when present')
    return errors


def library_record(record, legacy_v2=False):
    text = record.get('pageText') or ''
    if not isinstance(text, str):
        text = ''
    # Only a specifically labeled playtime value; never parse size or arbitrary numbers.
    play = re.search(r'\bTOTAL\s+PLAYED\s*:?\s*([\d,.]+)\s*(hours?|hrs?|minutes?|mins?)\b', text, re.I)
    hours = None if legacy_v2 else record.get('hours')
    if hours is None and play:
        try:
            value = float(play.group(1).replace(',', ''))
            hours = value / 60 if play.group(2).lower().startswith(('min',)) else value
        except ValueError:
            pass
    date = re.search(r'\bLAST\s+PLAYED\s*:?\s*(.+?)(?=\s+(?:ACHIEVEMENTS|MY GAME|TOTAL PLAYED|DOWNLOAD)\b|$)', text, re.I)
    achievement = re.search(r'\bACHIEVEMENTS\s*:?\s*(\d+)\s*/\s*(\d+)', text, re.I)
    return {'appid': record['appid'], 'name': record.get('name'), 'hours': hours,
            'playtimeDisplay': record.get('playtimeDisplay') or (play.group(0) if play else None),
            'lastPlayedDisplay': record.get('lastPlayedDisplay') or (date.group(1).strip() if date else None),
            'achievements': record.get('achievements') if record.get('achievements') is not None else ({'unlocked': int(achievement.group(1)), 'total': int(achievement.group(2))} if achievement else None),
            'raw': record}


def normalize(exports, account=None, batch_id=None):
    captures = []
    historical_users = {item['user'] for item in exports
                        if isinstance(item, dict) and item.get('type') in ('library', 'wishlist')
                        and isinstance(item.get('user'), str) and item['user'].strip()}
    if len(historical_users) > 1:
        raise ValueError('conflicting historical account identifiers; import separately')
    exports = [adapt_legacy(item) for item in exports]
    for name, value in (('account', account), ('batchId', batch_id)):
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise ValueError(f'{name} must be a nonempty string')
    if batch_id is not None and account is None:
        raise ValueError('batch association requires an explicit account alias')
    if account is not None:
        for item in exports:
            if not isinstance(item, dict):
                continue
            if item.get('account') is not None and item['account'] != account:
                raise ValueError('account association conflicts with an existing account alias')
            if batch_id is not None and item.get('batchId') is not None and item['batchId'] != batch_id:
                raise ValueError('batch association conflicts with an existing batch ID')
        exports = [dict(item, account=account, **({'batchId': batch_id} if batch_id is not None else {}))
                   if isinstance(item, dict) else item for item in exports]
    accounts = {item.get('account') for item in exports if isinstance(item, dict) and item.get('account')}
    if len(accounts) > 1:
        raise ValueError('cross-account import refused; normalize each account separately')
    for data in exports:
        errors = check_export(data)
        if errors:
            raise ValueError('; '.join(errors))
        seen, records, warnings = {}, [], list(data['warnings'])
        for record in data['records']:
            if data['source'] == 'replay':
                key = json.dumps(record, sort_keys=True, ensure_ascii=False)
            elif data['source'] == 'reviews':
                key = record.get('reviewUrl') or record['appid']
                if not isinstance(key, (str, int)):
                    raise ValueError('reviewUrl must be a string')
            else:
                key = record['appid']
            if key in seen:
                warnings.append(f'duplicate record {key} skipped within capture')
                if seen[key] != record:
                    warnings.append(f'conflicting duplicate record {key}; inspect rawRecords')
                continue
            seen[key] = record
            legacy_v2 = (data['source'] == 'library' and isinstance(data.get('originalExport'), dict) and
                         data['originalExport'].get('type') == 'library' and
                         data['originalExport'].get('schemaVersion') == 2)
            normalized_record = library_record(record, legacy_v2=legacy_v2) if data['source'] == 'library' else record
            if legacy_v2 and record.get('hours') is not None:
                if not isinstance(record.get('pageText'), str) or not record['pageText'].strip():
                    warnings.append(f"appid {record['appid']}: legacy v2 playtime is unverified; page text unavailable")
                elif record['hours'] != normalized_record['hours']:
                    warnings.append(f"appid {record['appid']}: legacy v2 playtime conflicts with labeled page evidence; original retained in raw record")
            records.append(normalized_record)
        if not records:
            warnings.append('no records collected; this does not prove the source is empty')
        if not data.get('account'):
            warnings.append('account identity not supplied; do not assume captures belong to the same account')
        expected = data.get('expectedCount')
        if isinstance(expected, int) and not isinstance(expected, bool) and expected != len(records):
            warnings.append(f'expected count {expected} differs from {len(records)} unique records')
        for record in records:
            if data['source'] != 'library':
                continue
            hours = record.get('hours')
            if hours is not None and (isinstance(hours, bool) or not isinstance(hours, (int, float)) or not math.isfinite(hours) or hours < 0):
                warnings.append(f"appid {record['appid']}: invalid playtime")
            ach = record.get('achievements')
            if ach is not None and (not isinstance(ach, dict) or any(not isinstance(ach.get(k), int) or isinstance(ach.get(k), bool) or ach[k] < 0 for k in ('unlocked', 'total')) or ach['unlocked'] > ach['total']):
                warnings.append(f"appid {record['appid']}: invalid achievement counts")
        captures.append({'source': data['source'], 'capturedAt': data['capturedAt'], 'method': data['method'],
                         'coverage': data['coverage'], 'inputCount': len(data['records']), 'recordCount': len(records),
                         'warnings': warnings, 'records': records, 'rawRecords': data['records'],
                         'account': data.get('account'), 'batchId': data.get('batchId')})
        if 'originalExport' in data:
            captures[-1]['originalExport'] = data['originalExport']
        else:
            captures[-1]['originalExport'] = data
    captures.sort(key=lambda x: datetime.datetime.fromisoformat(x['capturedAt'].replace('Z', '+00:00')))
    # A queryable latest observation per source and AppID, never a full snapshot:
    # absence from a partial capture cannot establish removal or non-ownership.
    latest = {}
    for capture in captures:
        if not capture['account'] or capture['source'] == 'replay':
            continue
        for record in capture['records']:
            key = (capture['account'], capture['source'], record['appid'])
            previous = latest.get(key)
            history = previous['previousObservations'] + [{k: previous[k] for k in ('capturedAt', 'batchId', 'record')}] if previous else []
            latest[key] = {'account': capture['account'], 'source': capture['source'],
                           'capturedAt': capture['capturedAt'], 'batchId': capture['batchId'], 'record': record,
                           'previousObservations': history}
    return {'format': 'game-curator-normalized', 'version': 1, 'captures': captures,
            'latestObservations': list(latest.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', nargs='+')
    parser.add_argument('--output', required=True)
    parser.add_argument('--account', help='Associate all inputs with this verified, user-chosen local alias')
    parser.add_argument('--batch-id', help='Associate all inputs with this acquisition batch; requires --account')
    args = parser.parse_args()
    try:
        values = [json.loads(Path(path).read_text(encoding='utf-8')) for path in args.inputs]
        result = normalize(values, account=args.account, batch_id=args.batch_id)
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    except (OSError, ValueError, TypeError) as exc:
        print(f'Import failed: {exc}', file=sys.stderr)
        return 1
    print(f"Wrote {len(result['captures'])} captures to {args.output}; review coverage and warnings.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
