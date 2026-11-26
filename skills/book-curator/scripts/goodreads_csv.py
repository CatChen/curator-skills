#!/usr/bin/env python3
"""Conservatively normalize a user-provided Goodreads CSV; never overwrite output."""
import argparse
import csv
from datetime import datetime, timezone
import json
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
    records, warnings = [], []
    for line, row in enumerate(reader, start=2):
        if None in row or any(v is None for v in row.values()):
            raise ValueError(f'CSV row {line} has a different number of fields than its header')
        item = {target: (row.get(source, '').strip() or None) for source, target in FIELDS.items()}
        for field in ('isbn', 'isbn13'):
            item[field] = clean_identifier(item[field] or '')
        rating = item['rating']
        if rating is None or rating == '0':
            item['rating'] = None
        elif rating in ('1', '2', '3', '4', '5'):
            item['rating'] = int(rating)
        else:
            item['rating'] = None
            warnings.append(f'Row {line}: invalid rating retained in original metadata')
        if not item['title']:
            warnings.append(f'Row {line}: missing title')
        item['original'] = row
        records.append(item)
    return {'format': 'book-curator-goodreads-normalized', 'version': 1,
            'source': 'goodreads-csv', 'capturedAt': captured_at or datetime.now(timezone.utc).isoformat(),
            'exportedAt': None, 'account': None, 'accessScope': 'unknown', 'coverage': 'unknown',
            'warnings': ['Export completeness, account and export time are unverified.'] + warnings,
            'records': records}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    try:
        with args.input.open(encoding='utf-8-sig', newline='') as source:
            result = normalize(source)
        # Exclusive creation prevents accidental destruction of existing user data.
        with args.output.open('x', encoding='utf-8') as destination:
            json.dump(result, destination, ensure_ascii=False, indent=2)
            destination.write('\n')
    except (OSError, UnicodeError, csv.Error, ValueError) as exc:
        parser.exit(1, f'Import failed: {exc}\n')

if __name__ == '__main__':
    main()
