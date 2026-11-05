import type { LabelFields } from '../rules/types';

const KEY_MAP: Array<[RegExp, keyof LabelFields]> = [
  [/^brand(?:\s*name)?$/i, 'brand'],
  [/^class(?:\s*\/\s*type)?$|^type$|^class\s*type$/i, 'classType'],
  [/^alcohol(?:\s*content)?$|^abv$/i, 'abv'],
  [/^net\s*contents?$|^volume$/i, 'netContents'],
  [/^country(?:\s*of\s*origin)?$|^origin$/i, 'origin'],
];

const KEY_LINE = /^\s*([A-Za-z][A-Za-z /]*?)\s*:\s*(.*)$/;
const WARNING_LINE = /^\s*government\s+warning\s*:/i;

export function emptyLabel(): LabelFields {
  return { brand: '', classType: '', abv: '', netContents: '', origin: '', warning: '' };
}

function lookupKey(raw: string): keyof LabelFields | null {
  for (const [re, field] of KEY_MAP) {
    if (re.test(raw.trim())) return field;
  }
  return null;
}

/**
 * Read label text such as:
 *
 *   Brand Name: OLD TOM DISTILLERY
 *   Alcohol Content: 45% Alc./Vol. (90 Proof)
 *   GOVERNMENT WARNING: (1) According to ...
 *
 * The warning line is kept exactly as written (including its capitalization)
 * because the header's case is part of what gets checked.
 */
export function parseLabelText(text: string): LabelFields {
  const fields = emptyLabel();
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let inWarning = false;

  for (const line of lines) {
    if (WARNING_LINE.test(line)) {
      inWarning = true;
      fields.warning = line.trim();
      continue;
    }

    const kv = line.match(KEY_LINE);
    const field = kv ? lookupKey(kv[1]) : null;
    if (kv && field) {
      inWarning = false;
      fields[field] = kv[2].trim();
      continue;
    }

    if (inWarning && line.trim()) {
      fields.warning += ' ' + line.trim();
    }
  }

  // Fallbacks for loosely formatted text when a labelled line is missing.
  if (!fields.abv) {
    const m = text.match(/\d+(?:\.\d+)?\s*%[^\n]*/);
    if (m) fields.abv = m[0].trim();
  }
  if (!fields.netContents) {
    const m = text.match(/\d+(?:\.\d+)?\s*(?:ml|cl|l|fl\.?\s*oz)\b/i);
    if (m) fields.netContents = m[0].trim();
  }

  return fields;
}

/** Names of the fields that could not be read, for friendly messages. */
export function missingLabelFields(label: LabelFields): string[] {
  const names: Record<keyof LabelFields, string> = {
    brand: 'Brand name',
    classType: 'Class/type',
    abv: 'Alcohol content',
    netContents: 'Net contents',
    origin: 'Country of origin',
    warning: 'Government warning',
  };
  return (Object.keys(names) as Array<keyof LabelFields>)
    .filter((k) => k !== 'origin' && !label[k])
    .map((k) => names[k]);
}
