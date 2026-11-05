import { useMemo, useRef, useState } from 'react';
import { ensureEngine, recommendedWorkers } from '../ocr/engine';
import { errorMessage } from '../ocr/errors';
import { readLabelImage } from '../ocr/readLabel';
import { downloadText, resultsToCsv, type BatchResult } from '../parsing/exportCsv';
import { parseBatchCsv } from '../parsing/parseCsv';
import { SAMPLES, fetchSampleFile, sampleUrl } from '../samples';
import type { BatchRow, Status } from '../rules/types';
import { verifyLabel } from '../rules/verify';
import { FileDrop } from './FileDrop';
import { ResultsTable } from './ResultsTable';

const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];

const failure = (row: BatchRow, order: number, message: string): BatchResult => ({
  ...row,
  order,
  source: row.imageFile ? 'image' : 'text',
  result: { overall: 'fail', checks: [{ field: 'Label', status: 'fail', message }] },
});

async function checkRow(row: BatchRow, order: number, images: Map<string, File>): Promise<BatchResult> {
  if (row.imageFile) {
    const file = images.get(row.imageFile.toLowerCase());
    if (!file) return failure(row, order, `The picture "${row.imageFile}" was not uploaded along with the spreadsheet.`);
    try {
      const reading = await readLabelImage(file, {
        hints: { brand: row.app.brand, classType: row.app.classType },
      });
      const result = verifyLabel(row.app, reading.fields, { ocr: true, bold: reading.bold });
      if (!reading.rawText.trim()) {
        return failure(row, order, `No text could be read from "${row.imageFile}". Try a clearer picture.`);
      }
      return { ...row, order, source: 'image', reading, file, result };
    } catch (e) {
      return failure(row, order, errorMessage(e));
    }
  }
  if (row.label.brand || row.label.warning) {
    return { ...row, order, source: 'text', result: verifyLabel(row.app, row.label) };
  }
  return failure(row, order, 'This row has neither a picture file name nor label text.');
}

export function BatchUpload() {
  const [csvName, setCsvName] = useState('');
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [images, setImages] = useState<Map<string, File>>(new Map());
  const [results, setResults] = useState<BatchResult[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [seconds, setSeconds] = useState<number | null>(null);
  const cancel = useRef(false);

  const reset = () => {
    cancel.current = true;
    setCsvName('');
    setRows([]);
    setImages(new Map());
    setResults([]);
    setErrors([]);
    setWarnings([]);
    setRunning(false);
    setDone(0);
    setSeconds(null);
  };

  const addFiles = async (files: File[]) => {
    setErrors([]);
    setResults([]);
    setSeconds(null);
    const csv = files.find((f) => f.name.toLowerCase().endsWith('.csv'));
    const pics = files.filter((f) => IMAGE_TYPES.some((ext) => f.name.toLowerCase().endsWith(ext)));

    if (pics.length) {
      setImages((prev) => {
        const next = new Map(prev);
        pics.forEach((f) => next.set(f.name.toLowerCase(), f));
        return next;
      });
    }
    if (csv) {
      const parsed = parseBatchCsv(await csv.text());
      setCsvName(csv.name);
      setWarnings(parsed.warnings);
      setErrors(parsed.errors);
      setRows(parsed.errors.length ? [] : parsed.rows);
    }
  };

  const loadSampleBatch = async () => {
    reset();
    cancel.current = false;
    try {
      const files = await Promise.all([
        fetchSampleFile('sample-batch-images.csv'),
        ...SAMPLES.map((s) => fetchSampleFile(`images/${s.file}`)),
      ]);
      await addFiles(files);
    } catch (e) {
      setErrors([errorMessage(e)]);
    }
  };

  const missing = useMemo(
    () => [...new Set(rows.filter((r) => r.imageFile && !images.has(r.imageFile.toLowerCase())).map((r) => r.imageFile))],
    [rows, images],
  );
  const usesImages = rows.some((r) => r.imageFile);

  const start = async () => {
    cancel.current = false;
    setRunning(true);
    setResults([]);
    setDone(0);
    setSeconds(null);
    const t0 = performance.now();
    const workers = usesImages ? recommendedWorkers() : 1;
    try {
      if (usesImages) await ensureEngine(workers);
      let next = 0;
      const loop = async () => {
        while (!cancel.current) {
          const i = next++;
          if (i >= rows.length) return;
          const r = await checkRow(rows[i], i, images);
          if (cancel.current) return;
          setResults((prev) => [...prev, r]);
          setDone((d) => d + 1);
        }
      };
      await Promise.all(Array.from({ length: workers }, loop));
      if (!cancel.current) setSeconds((performance.now() - t0) / 1000);
    } catch (e) {
      setErrors([errorMessage(e)]);
    } finally {
      setRunning(false);
    }
  };

  const counts = useMemo(() => {
    const c: Record<Status, number> = { pass: 0, review: 0, fail: 0 };
    for (const r of results) c[r.result.overall]++;
    return c;
  }, [results]);

  const pct = rows.length ? Math.round((done / rows.length) * 100) : 0;

  return (
    <div>
      <h2>Check many labels at once</h2>
      <p className="muted">
        Choose the spreadsheet (.csv) <strong>and</strong> all of the label pictures together. In the file
        window you can select many files at once. The spreadsheet lists each application and the name of its
        picture file in an <code>image_file</code> column.
      </p>

      <FileDrop
        accept={['.csv', ...IMAGE_TYPES]}
        multiple
        title="Upload the spreadsheet and the label pictures"
        onFiles={addFiles}
        onError={(m) => setErrors([m])}
      />

      <div className="actions">
        <button type="button" className="btn" onClick={loadSampleBatch} disabled={running}>
          Load the 10 sample labels
        </button>
        <a className="btn" href={sampleUrl('sample-batch-images.zip')} download>
          Download sample files (zip)
        </a>
        <a className="btn" href={sampleUrl('sample-batch-images.csv')} download>
          Download sample spreadsheet
        </a>
      </div>

      {errors.map((e) => (
        <p key={e} className="error" role="alert">
          {e}
        </p>
      ))}

      {warnings.length > 0 && (
        <details className="warn-box">
          <summary>{warnings.length} formatting warning(s) in the spreadsheet</summary>
          <ul>
            {warnings.slice(0, 20).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      {rows.length > 0 && (
        <div className="ready">
          <p>
            <strong>{csvName}</strong>: {rows.length} application{rows.length === 1 ? '' : 's'}.{' '}
            {usesImages && (
              <>
                {images.size} picture{images.size === 1 ? '' : 's'} chosen.
              </>
            )}
          </p>
          {missing.length > 0 && (
            <p className="warn-text">
              {missing.length} picture{missing.length === 1 ? ' is' : 's are'} listed in the spreadsheet but not
              uploaded yet: {missing.slice(0, 5).join(', ')}
              {missing.length > 5 ? ', …' : ''}. Add them above, or those rows will be marked as problems.
            </p>
          )}
          <div className="actions">
            <button type="button" className="btn btn-primary btn-large" onClick={start} disabled={running}>
              {running ? 'Checking…' : `Check ${rows.length} label${rows.length === 1 ? '' : 's'}`}
            </button>
            {running && (
              <button type="button" className="btn" onClick={() => (cancel.current = true)}>
                Stop
              </button>
            )}
            {results.length > 0 && !running && (
              <button
                type="button"
                className="btn"
                onClick={() => downloadText('label-results.csv', resultsToCsv([...results].sort((a, b) => a.order - b.order)))}
              >
                Export results as CSV
              </button>
            )}
            <button type="button" className="btn" onClick={reset} disabled={running}>
              Start over
            </button>
          </div>
        </div>
      )}

      {running && (
        <div className="status" role="status">
          <div className="bar" aria-hidden="true">
            <div className="bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <p>
            Checked {done} of {rows.length}. The first picture takes a few seconds while the reader starts.
          </p>
        </div>
      )}

      {results.length > 0 && (
        <>
          <p className="muted">
            {running ? 'Results so far: ' : `Checked ${results.length} of ${rows.length} label${rows.length === 1 ? '' : 's'}`}
            {seconds !== null && ` in ${seconds.toFixed(1)} seconds (${(seconds / results.length).toFixed(1)} s per label)`}
            {!running && '.'}
          </p>
          <div className="summary">
            <div className="stat stat-pass">
              <strong>{counts.pass}</strong> Pass
            </div>
            <div className="stat stat-review">
              <strong>{counts.review}</strong> Need review
            </div>
            <div className="stat stat-fail">
              <strong>{counts.fail}</strong> Fail
            </div>
          </div>
          <ResultsTable results={results} />
        </>
      )}
    </div>
  );
}
