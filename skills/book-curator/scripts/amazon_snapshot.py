#!/usr/bin/env python3
"""Read-only summary and integrity check of an existing Book Curator Amazon snapshot.

Historical evidence only: this never contacts Amazon and never writes files. Output is counts and
booleans only: no titles, authors, source identifiers, account aliases or free-text warnings.
Usage: amazon_snapshot.py SNAPSHOT.json [--evidence SIDECAR.json]
Without --evidence it looks for SNAPSHOT.json.evidence.json beside the snapshot.
"""
import hashlib
import json
import os
import sys

FORMAT = 'book-curator-amazon-content'
SOURCE_TYPES = ('KindleEBook', 'KindleEBookSample', 'KindlePDoc')
COVERAGE = ('complete-observed', 'partial')


def load(path):
    with open(path, 'rb') as handle:
        data = handle.read()
    return data, json.loads(data.decode('utf-8'))


def text(value):
    return isinstance(value, str) and bool(value.strip())


def identity(sidecar, associated):
    """Association (integrity) is separate from recorded identity; unknown unless explicitly recorded."""
    if sidecar is None:
        return 'unknown', 'no-sidecar'
    if not associated:
        return 'unknown', 'sidecar-does-not-match-snapshot'
    claim = sidecar.get('accountIdentity')
    if not (text(sidecar.get('accountAlias')) and text(claim) and text(sidecar.get('accountVerification'))):
        return 'unknown', 'alias-or-verification-not-recorded'
    if any(word in claim.lower() for word in ('unverified', 'unknown', 'not verified')):
        return 'unknown', 'sidecar-states-identity-unverified'
    return 'recorded', 'alias-and-verification-recorded'


def summarize(snapshot_path, evidence_path=None):
    data, snap = load(snapshot_path)
    if not isinstance(snap, dict) or snap.get('format') != FORMAT or snap.get('version') != 1:
        raise ValueError('not a book-curator-amazon-content version 1 snapshot (an evidence sidecar goes after --evidence)')
    records = snap.get('records')
    if snap.get('category') not in ('books', 'docs') or not isinstance(records, list):
        raise ValueError('invalid category or records')
    types = {name: 0 for name in SOURCE_TYPES}
    malformed = unsupported = missing_ids = 0
    ids = []
    for record in records:
        if not isinstance(record, dict):
            malformed += 1
            continue
        kind, source_id = record.get('sourceType'), record.get('sourceId')
        if kind in SOURCE_TYPES:
            types[kind] += 1
        else:
            unsupported += 1
        if not text(source_id) or not isinstance(kind, str):
            missing_ids += 1
        else:
            ids.append((kind, source_id))
    diag = snap.get('diagnostics') if isinstance(snap.get('diagnostics'), dict) else {}
    total = diag.get('displayedTotal') if isinstance(diag.get('displayedTotal'), int) and not isinstance(diag.get('displayedTotal'), bool) else None
    digest = hashlib.sha256(data).hexdigest()
    warnings = snap.get('warnings')
    problems = []
    if malformed:
        problems.append('malformed records')
    if unsupported:
        problems.append('unsupported or missing source types')
    if missing_ids:
        problems.append('missing or invalid source identifiers')
    if len(set(ids)) != len(ids):
        problems.append('duplicate source identifiers')
    if total is not None and total != len(records):
        problems.append('record count differs from displayed total')
    sidecar, checks = None, None
    evidence_path = evidence_path or snapshot_path + '.evidence.json'
    if os.path.exists(evidence_path):
        try:
            sidecar = load(evidence_path)[1]
        except (ValueError, OSError):
            sidecar = None
            problems.append('evidence sidecar unreadable')
        else:
            if not isinstance(sidecar, dict):
                sidecar = None
                problems.append('evidence sidecar is not an object')
    if sidecar is not None:
        checks = {'digestMatches': sidecar.get('sha256') == digest,
                  'nameMatches': sidecar.get('snapshot') == os.path.basename(snapshot_path),
                  'categoryMatches': sidecar.get('category') == snap['category'],
                  'capturedAtMatches': sidecar.get('capturedAt') == snap.get('capturedAt')}
        if not all(checks.values()):
            problems.append('evidence sidecar mismatch')
    state, reason = identity(sidecar, bool(checks) and all(checks.values()))
    return {
        'category': snap['category'], 'isHistorical': True, 'capturedAtRecorded': text(snap.get('capturedAt')),
        'coverage': snap.get('coverage') if snap.get('coverage') in COVERAGE else 'unrecognized',
        'recordCount': len(records), 'uniqueIds': len(set(ids)), 'sourceTypes': types,
        'unsupportedSourceTypes': unsupported, 'malformedRecords': malformed, 'missingIds': missing_ids,
        'displayedTotal': total, 'snapshotWarningCount': len(warnings) if isinstance(warnings, list) else None,
        'sha256': digest, 'evidenceAssociation': checks,
        'identity': state, 'identityReason': reason,
        'problems': problems,
        'note': 'Historical capture; current Amazon access and freshness are not claimed. Association is integrity, not proof of account or scope; identity is "recorded" only when the sidecar states an alias and verification, and is never independently verified here.',
    }


def main(argv):
    args = argv[1:]
    evidence = None
    if '--evidence' in args:
        i = args.index('--evidence')
        evidence = args[i + 1] if i + 1 < len(args) else None
        if evidence is None:
            print(__doc__, file=sys.stderr)
            return 2
        args = args[:i] + args[i + 2:]
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        print(json.dumps(summarize(args[0], evidence), indent=2))
    except (ValueError, OSError):
        print('error: cannot read a valid snapshot (an evidence sidecar goes after --evidence)', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
