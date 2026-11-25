#!/usr/bin/env python3
"""Normalize version 1 Steam captures without discarding historical observations."""
import argparse
import datetime
import json
import re
import sys
from pathlib import Path

SOURCES = {'library', 'wishlist', 'reviews', 'replay'}


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
    return errors


def library_record(record):
    text = record.get('pageText') or ''
    if not isinstance(text, str):
        text = ''
    # Only a specifically labeled playtime value; never parse size or arbitrary numbers.
    play = re.search(r'\bTOTAL\s+PLAYED\s*:?\s*([\d,.]+)\s*(hours?|hrs?|minutes?|mins?)\b', text, re.I)
    hours = None
    if play:
        try:
            value = float(play.group(1).replace(',', ''))
            hours = value / 60 if play.group(2).lower().startswith(('min',)) else value
        except ValueError:
            pass
    date = re.search(r'\bLAST\s+PLAYED\s*:?\s*(.+?)(?=\s+(?:ACHIEVEMENTS|MY GAME|TOTAL PLAYED|DOWNLOAD)\b|$)', text, re.I)
    achievement = re.search(r'\bACHIEVEMENTS\s*:?\s*(\d+)\s*/\s*(\d+)', text, re.I)
    return {'appid': record['appid'], 'name': record.get('name'), 'hours': hours,
            'playtimeDisplay': play.group(0) if play else None,
            'lastPlayedDisplay': date.group(1).strip() if date else None,
            'achievements': {'unlocked': int(achievement.group(1)), 'total': int(achievement.group(2))} if achievement else None,
            'raw': record}


def normalize(exports):
    captures = []
    for data in exports:
        errors = check_export(data)
        if errors:
            raise ValueError('; '.join(errors))
        seen, records, warnings = set(), [], list(data['warnings'])
        for record in data['records']:
            if data['source'] == 'replay':
                key = json.dumps(record, sort_keys=True, ensure_ascii=False)
            elif data['source'] == 'reviews':
                key = record.get('reviewUrl') or record['appid']
            else:
                key = record['appid']
            if key in seen:
                warnings.append(f'duplicate record {key} skipped within capture')
                continue
            seen.add(key)
            records.append(library_record(record) if data['source'] == 'library' else record)
        if not records:
            warnings.append('no records collected; this does not prove the source is empty')
        captures.append({'source': data['source'], 'capturedAt': data['capturedAt'], 'method': data['method'],
                         'coverage': data['coverage'], 'inputCount': len(data['records']), 'recordCount': len(records),
                         'warnings': warnings, 'records': records})
    captures.sort(key=lambda x: datetime.datetime.fromisoformat(x['capturedAt'].replace('Z', '+00:00')))
    return {'format': 'game-curator-normalized', 'version': 1, 'captures': captures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', nargs='+')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        values = [json.loads(Path(path).read_text(encoding='utf-8')) for path in args.inputs]
        result = normalize(values)
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    except (OSError, ValueError, TypeError) as exc:
        print(f'Import failed: {exc}', file=sys.stderr)
        return 1
    print(f"Wrote {len(result['captures'])} captures to {args.output}; review coverage and warnings.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
