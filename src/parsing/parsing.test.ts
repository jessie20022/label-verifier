import { describe, expect, it } from 'vitest';
import { WARNING } from '../rules/checks';
import { parseBatchCsv } from './parseCsv';
import { missingLabelFields, parseLabelText } from './parseLabelText';

const HEADER =
  'id,app_brand,app_class,app_abv,app_net,app_origin,label_brand,label_class,label_abv,label_net,label_origin,label_warning';

describe('parseLabelText', () => {
  const text = [
    'Brand Name: OLD TOM DISTILLERY',
    'Class/Type: Kentucky Straight Bourbon Whiskey',
    'Alcohol Content: 45% Alc./Vol. (90 Proof)',
    'Net Contents: 750 mL',
    // Wrap the warning across two lines at a word boundary, as a label file might.
    WARNING.slice(0, WARNING.indexOf('(2)')).trimEnd(),
    WARNING.slice(WARNING.indexOf('(2)')),
  ].join('\n');

  it('reads labelled lines', () => {
    const f = parseLabelText(text);
    expect(f.brand).toBe('OLD TOM DISTILLERY');
    expect(f.classType).toBe('Kentucky Straight Bourbon Whiskey');
    expect(f.abv).toBe('45% Alc./Vol. (90 Proof)');
    expect(f.netContents).toBe('750 mL');
  });

  it('keeps the warning exactly as written, joining wrapped lines', () => {
    const f = parseLabelText(text);
    expect(f.warning.startsWith('GOVERNMENT WARNING:')).toBe(true);
    expect(f.warning.replace(/\s+/g, ' ')).toBe(WARNING);
  });

  it('preserves a title-case warning header so it can be rejected', () => {
    const f = parseLabelText('Government Warning: (1) According to the Surgeon General');
    expect(f.warning.startsWith('Government Warning:')).toBe(true);
  });

  it('reports missing fields', () => {
    expect(missingLabelFields(parseLabelText('Brand Name: X'))).toContain('Net contents');
  });
});

describe('parseBatchCsv', () => {
  it('rejects an empty file', () => {
    expect(parseBatchCsv('   ').errors[0]).toMatch(/empty/i);
  });

  it('names the missing columns', () => {
    const r = parseBatchCsv('id,app_brand\n1,X');
    expect(r.errors[0]).toContain('label_warning');
    expect(r.errors[0]).toContain('app_abv');
  });

  it('rejects a header with no data', () => {
    expect(parseBatchCsv(HEADER).errors[0]).toMatch(/no data rows/i);
  });

  it('parses quoted fields containing commas and handles a BOM', () => {
    const csv = `﻿${HEADER}\n1,A,B,45,750 mL,,A,B,45%,750 mL,,"${WARNING}"`;
    const r = parseBatchCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].label.warning).toBe(WARNING);
  });

  it('treats empty cells as empty strings and generates ids', () => {
    const r = parseBatchCsv(`${HEADER}\n,A,B,45,750 mL,,A,B,45%,750 mL,,`);
    expect(r.rows[0].id).toBe('1');
    expect(r.rows[0].app.origin).toBe('');
    expect(r.rows[0].label.warning).toBe('');
  });

  it('is case-insensitive about header names', () => {
    const r = parseBatchCsv(`${HEADER.toUpperCase()}\n1,A,B,45,750 mL,,A,B,45%,750 mL,,x`);
    expect(r.errors).toEqual([]);
  });
});
