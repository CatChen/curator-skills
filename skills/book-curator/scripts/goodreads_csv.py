#!/usr/bin/env python3
"""Conservatively normalize a user-provided Goodreads CSV; never overwrite output."""
import argparse
import csv
from datetime import datetime, timezone
import json
import os
from decimal import Decimal, InvalidOperation
from pathlib import Path

FIELDS = {
    "Book Id": "goodreads_book_id", "Title": "title", "Author": "author",
    "Author l-f": "author_sort", "Additional Authors": "additional_authors",
    "ISBN": "isbn", "ISBN13": "isbn13", "My Rating": "rating",
    "Exclusive Shelf": "exclusive_shelf", "Bookshelves": "bookshelves",
    "My Review": "review", "Date Read": "date_read", "Date Added": "date_added",
    "Publisher": "publisher", "Binding": "binding", "Year Published": "year_published",
    "Original Publication Year": "original_publication_year", "Number of Pages": "pages",
}

# Columns kept verbatim under `original`: the mapped fields plus reread and ownership signals. Other export columns
# (private notes, purchase details, recommenders, condition) are not needed for curation and are not retained.
KEPT_COLUMNS = set(FIELDS) | {"Read Count", "Owned Copies"}

def clean_identifier(value):
    value = value.strip()
    # Goodreads exports may wrap ISBN in a spreadsheet formula, e.g. ="123".
    if value.startswith('="') and value.endswith('"'):
        value = value[2:-1]
    return value or None

def normalize(stream, captured_at=None):
    reader = csv.DictReader(stream, strict=True)
    headers = reader.fieldnames
    if not headers or 'Title' not in headers or 'Book Id' not in headers:
        raise ValueError('Expected Goodreads CSV headers including Book Id and Title')
    if len(headers) != len(set(headers)) or any(not h for h in headers):
        raise ValueError('Duplicate or empty CSV headers')
    records, warnings, ids = [], [], {}
    for line, row in enumerate(reader, start=2):
        if None in row or any(v is None for v in row.values()):
            raise ValueError(f'CSV row {line} has a different number of fields than its header')
        item = {target: (row.get(source, '').strip() or None) for source, target in FIELDS.items()}
        for field in ('isbn', 'isbn13'):
            item[field] = clean_identifier(item[field] or '')
        rating = item['rating']
        if rating is None:
            item['rating'] = None
        else:
            try:
                number = Decimal(rating)
                if not number.is_finite() or not (number == 0 or 1 <= number <= 5):
                    raise InvalidOperation
                item['rating'] = None if number == 0 else float(number)
            except InvalidOperation:
                item['rating'] = None
                warnings.append(f'Row {line}: invalid rating retained in original metadata')
        if not item['title']:
            warnings.append(f'Row {line}: missing title')
        book_id = item['goodreads_book_id']
        if not book_id:
            warnings.append(f'Row {line}: missing Goodreads book ID')
        elif book_id in ids:
            previous = ids[book_id]
            if any(previous.get(k) and item.get(k) and previous[k] != item[k] for k in ('title', 'author', 'isbn', 'isbn13')):
                warnings.append(f'Row {line}: conflicting metadata for repeated Goodreads book ID')
            else:
                warnings.append(f'Row {line}: repeated Goodreads book ID; retained separately')
        else:
            ids[book_id] = item.copy()
        item['original'] = {k: v for k, v in row.items() if k in KEPT_COLUMNS}
        records.append(item)
    if headers and (omitted := [h for h in headers if h not in KEPT_COLUMNS]):
        warnings.insert(0, f'{len(omitted)} export columns (such as private notes) were not retained.')
    return {'format': 'book-curator-goodreads-normalized', 'version': 1,
            'source': 'goodreads-csv', 'method': 'local-csv-normalization',
            'processedAt': captured_at or datetime.now(timezone.utc).isoformat(),
            'exportedAt': None, 'observedAt': None, 'account': None, 'accessScope': 'unknown', 'coverage': 'unknown',
            'warnings': ['Export completeness, account and export time are unverified.'] + warnings,
            'records': records}

def write_private_output(path, result):
    """Create mode-0600 output exclusively and verify bytes; remove only our inode on failure."""
    payload = (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode('utf-8')
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    identity = os.fstat(fd)
    try:
        with os.fdopen(fd, 'w+b') as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
            output.seek(0)
            if output.read() != payload:
                raise OSError('Output read-back did not match')
            current = os.stat(path, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
                raise OSError('Output path changed during write')
    except BaseException:
        try:
            current = os.stat(path, follow_symlinks=False)
            if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                os.unlink(path)
        except FileNotFoundError:
            pass
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    try:
        with args.input.open(encoding='utf-8-sig', newline='') as source:
            result = normalize(source)
        write_private_output(args.output, result)
    except (OSError, UnicodeError, csv.Error, ValueError) as exc:
        parser.exit(1, f'Import failed: {exc}\n')

if __name__ == '__main__':
    main()
