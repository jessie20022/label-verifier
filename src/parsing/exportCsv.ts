import Papa from 'papaparse';
import type { LabelReading } from '../ocr/types';
import type { BatchRow, VerificationResult } from '../rules/types';

export interface BatchResult extends BatchRow {
  result: VerificationResult;
  /** Where the label text came from. */
  source: 'image' | 'text';
  /** Position of the row in the uploaded spreadsheet. */
  order: number;
  /** What the OCR engine read, for image rows. */
  reading?: LabelReading;
  /** The image itself, so it can be shown next to the result. */
  file?: File;
}

export function resultsToCsv(results: BatchResult[]): string {
  const data = results.map((r) => {
    const byField = Object.fromEntries(r.result.checks.map((c) => [c.field, c.status]));
    return {
      id: r.id,
      image_file: r.imageFile,
      overall: r.result.overall,
      brand_name: byField['Brand name'],
      class_type: byField['Class/type'],
      alcohol_content: byField['Alcohol content'],
      net_contents: byField['Net contents'],
      country_of_origin: byField['Country of origin'],
      government_warning: byField['Government warning'],
      warning_header_bold: byField['Warning header bold'] ?? '',
      read_confidence: r.reading ? r.reading.confidence : '',
      problems: r.result.checks
        .filter((c) => c.status !== 'pass')
        .map((c) => `${c.field}: ${c.message}`)
        .join(' | '),
    };
  });
  return Papa.unparse(data);
}

/** Trigger a browser download of text content. */
export function downloadText(filename: string, content: string, mime = 'text/csv'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
