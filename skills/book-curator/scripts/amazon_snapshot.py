#!/usr/bin/env python3
"""Read-only summary and integrity check of an existing Book Curator Amazon snapshot.

Historical evidence only: this never contacts Amazon, never writes files, and prints no titles,
authors or source identifiers. Usage: amazon_snapshot.py SNAPSHOT.json [--evidence SIDECAR.json]
Without --evidence it looks for SNAPSHOT.json.evidence.json beside the snapshot.
"""
import hashlib
import json
import os
import sys

FORMAT = 'book-curator-amazon-content'


def load(path):
    with open(path, 'rb') as handle:
        data = handle.read()
    return data, json.loads(data.decode('utf-8'))


def summarize(snapshot_path, evidence_path=None):
    data, snap = load(snapshot_path)
    problems = []
    if not isinstance(snap, dict) or snap.get('format') != FORMAT or snap.get('version') != 1:
        raise ValueError('not a book-curator-amazon-content version 1 snapshot')
    records = snap.get('records')
    if snap.get('category') not in ('books', 'docs') or not isinstance(records, list):
        raise ValueError('invalid category or records')
    types = {}
    for record in records:
        key = record.get('sourceType') if isinstance(record, dict) else None
        types[str(key)] = types.get(str(key), 0) + 1
    ids = [(r.get('sourceType'), r.get('sourceId')) for r in records if isinstance(r, dict)]
    diag = snap.get('diagnostics') if isinstance(snap.get('diagnostics'), dict) else {}
    digest = hashlib.sha256(data).hexdigest()
    result = {
        'category': snap['category'], 'capturedAt': snap.get('capturedAt'), 'coverage': snap.get('coverage'),
        'method': snap.get('method'), 'recordCount': len(records), 'uniqueIds': len(set(ids)),
        'sourceTypes': types, 'displayedTotal': diag.get('displayedTotal'), 'warnings': snap.get('warnings', []),
        'sha256': digest, 'isHistorical': True,
        'note': 'Historical capture; current Amazon access and freshness are not claimed. Listing is not ownership, purchase, reading or enjoyment.',
    }
    if len(set(ids)) != len(records):
        problems.append('duplicate or missing source identifiers')
    if diag.get('displayedTotal') is not None and diag.get('displayedTotal') != len(records):
        problems.append('record count differs from displayed total')
    evidence_path = evidence_path or snapshot_path + '.evidence.json'
    if not os.path.exists(evidence_path):
        result['identity'] = 'unknown: no evidence sidecar'
    else:
        try:
            _, ev = load(evidence_path)
            checks = {
                'digestMatches': ev.get('sha256') == digest,
                'nameMatches': ev.get('snapshot') == os.path.basename(snapshot_path),
                'categoryMatches': ev.get('category') == snap['category'],
                'capturedAtMatches': ev.get('capturedAt') == snap.get('capturedAt'),
            }
        except (ValueError, OSError):
            checks = {'readable': False}
        result['evidenceChecks'] = checks
        if all(checks.values()):
            result['identity'] = 'user-approved alias recorded: ' + str(ev.get('accountAlias'))
        else:
            result['identity'] = 'unknown: evidence sidecar does not match snapshot'
            problems.append('evidence sidecar mismatch')
    result['problems'] = problems
    return result


def main(argv):
    args = argv[1:]
    evidence = None
    if '--evidence' in args:
        i = args.index('--evidence')
        evidence = args[i + 1] if i + 1 < len(args) else None
        args = args[:i] + args[i + 2:]
    if len(args) != 1 or (evidence is None and '--evidence' in argv):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        print(json.dumps(summarize(args[0], evidence), indent=2))
    except (ValueError, OSError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
