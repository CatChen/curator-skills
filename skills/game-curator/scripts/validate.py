#!/usr/bin/env python3
"""Validate the structure of a normalized Game Curator archive."""
import argparse
import json
import sys
from pathlib import Path
from normalize import check_export


def validate(data):
    errors, warnings = [], []
    if not isinstance(data, dict) or data.get('format') != 'game-curator-normalized' or data.get('version') != 1:
        return ['unsupported normalized format or version'], warnings
    if not isinstance(data.get('captures'), list):
        return ['captures must be a list'], warnings
    for i, capture in enumerate(data['captures']):
        if not isinstance(capture, dict):
            errors.append(f'capture {i}: expected object')
            continue
        candidate = dict(capture, format='game-curator-steam-export', version=1)
        errors.extend(f'capture {i}: {e}' for e in check_export(candidate))
        records = capture.get('records')
        if isinstance(records, list) and capture.get('recordCount') != len(records):
            errors.append(f'capture {i}: recordCount mismatch')
        if capture.get('coverage') != 'complete':
            warnings.append(f'capture {i}: coverage is {capture.get("coverage")}')
        if isinstance(capture.get('warnings'), list):
            warnings.extend(f'capture {i}: {w}' for w in capture['warnings'] if isinstance(w, str))
        if not capture.get('account'):
            warnings.append(f'capture {i}: account is unknown; cross-capture identity is unverified')
        if isinstance(records, list) and not records:
            warnings.append(f'capture {i}: empty collection requires source and coverage verification')
    return errors, warnings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file')
    args = parser.parse_args()
    try:
        errors, warnings = validate(json.loads(Path(args.file).read_text(encoding='utf-8')))
    except (OSError, ValueError) as exc:
        print(f'Validation failed: {exc}', file=sys.stderr)
        return 1
    for message in warnings:
        print(f'WARNING: {message}')
    for message in errors:
        print(f'ERROR: {message}', file=sys.stderr)
    if not errors:
        print('Structure valid; completeness and accuracy are not established.')
    return bool(errors)


if __name__ == '__main__':
    sys.exit(main())
