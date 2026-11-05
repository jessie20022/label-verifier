import Papa from 'papaparse';
import type { BatchRow } from '../rules/types';

/** Always required: what the applicant declared. */
export const APPLICATION_COLUMNS = ['app_brand', 'app_class', 'app_abv', 'app_net'] as const;

/** Required when there is no image_file column: the label text itself. */
export const LABEL_TEXT_COLUMNS = [
  'label_brand',
  'label_class',
  'label_abv',
  'label_net',
  'label_warning',
] as const;

export const OPTIONAL_COLUMNS = ['id', 'app_origin', 'image_file', 'label_origin'] as const;

export interface ParseCsvResult {
  rows: BatchRow[];
  /** Problems that stop processing. */
  errors: string[];
  /** Problems worth mentioning that do not stop processing. */
  warnings: string[];
}

export function parseBatchCsv(text: string): ParseCsvResult {
  const clean = text.replace(/^﻿/, '');
  if (!clean.trim()) {
    return { rows: [], errors: ['The file is empty. Please choose a CSV that has a header row and data rows.'], warnings: [] };
  }

  const parsed = Papa.parse<Record<string, string>>(clean, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  const columns = parsed.meta.fields ?? [];
  const hasImageColumn = columns.includes('image_file');
  const needed = hasImageColumn ? APPLICATION_COLUMNS : [...APPLICATION_COLUMNS, ...LABEL_TEXT_COLUMNS];
  const missing = needed.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    const hint = hasImageColumn
      ? ''
      : ' Add an image_file column to read label pictures, or include the label_* text columns.';
    return {
      rows: [],
      errors: [
        `This file is missing ${missing.length === 1 ? 'a required column' : 'required columns'}: ${missing.join(', ')}.${hint}`,
      ],
      warnings: [],
    };
  }

  if (parsed.data.length === 0) {
    return { rows: [], errors: ['The file has a header row but no data rows.'], warnings: [] };
  }

  const warnings = parsed.errors.map((e) => `Row ${(e.row ?? 0) + 2}: ${e.message}`);
  const get = (r: Record<string, string>, key: string) => (r[key] ?? '').trim();

  const rows: BatchRow[] = parsed.data.map((r, i) => ({
    id: get(r, 'id') || String(i + 1),
    imageFile: get(r, 'image_file'),
    app: {
      brand: get(r, 'app_brand'),
      classType: get(r, 'app_class'),
      abv: get(r, 'app_abv'),
      netContents: get(r, 'app_net'),
      origin: get(r, 'app_origin'),
    },
    label: {
      brand: get(r, 'label_brand'),
      classType: get(r, 'label_class'),
      abv: get(r, 'label_abv'),
      netContents: get(r, 'label_net'),
      origin: get(r, 'label_origin'),
      warning: get(r, 'label_warning'),
    },
  }));

  return { rows, errors: [], warnings };
}
