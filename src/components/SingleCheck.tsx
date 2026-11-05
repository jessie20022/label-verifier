import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../ocr/errors';
import { readLabelImage } from '../ocr/readLabel';
import type { LabelReading, Stage } from '../ocr/types';
import { missingLabelFields, parseLabelText } from '../parsing/parseLabelText';
import { SAMPLES, fetchSampleFile, sampleUrl } from '../samples';
import { verifyLabel } from '../rules/verify';
import type { Application, VerificationResult } from '../rules/types';
import { CheckList } from './CheckList';
import { FileDrop } from './FileDrop';
import { ReadDetails } from './ReadDetails';

const EMPTY_APP: Application = { brand: '', classType: '', abv: '', netContents: '', origin: '' };
const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];

const STAGE_TEXT: Record<Stage, string> = {
  engine: 'Starting the reader (the first time takes a few seconds)…',
  prepare: 'Preparing the picture…',
  read: 'Reading the label…',
  rotate: 'Turning the picture to find the text…',
  straighten: 'Straightening the picture…',
  extract: 'Sorting the text into fields…',
};

export function SingleCheck() {
  const [app, setApp] = useState<Application>(EMPTY_APP);
  const [image, setImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [labelText, setLabelText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<Stage | null>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [reading, setReading] = useState<LabelReading | null>(null);
  const [textRead, setTextRead] = useState<Record<string, string> | null>(null);
  const run = useRef(0);

  useEffect(() => {
    if (!image) {
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(image);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const clearResult = () => {
    setResult(null);
    setReading(null);
    setTextRead(null);
  };

  const setField = (key: keyof Application) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setApp((prev) => ({ ...prev, [key]: e.target.value }));

  const loadSample = async (file: string) => {
    const sample = SAMPLES.find((s) => s.file === file);
    if (!sample) return;
    setError('');
    clearResult();
    setLabelText('');
    setApp(sample.app);
    try {
      setImage(await fetchSampleFile(`images/${sample.file}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const clearAll = () => {
    run.current++;
    setApp(EMPTY_APP);
    setImage(null);
    setLabelText('');
    setError('');
    setBusy(null);
    clearResult();
  };

  const onFiles = async ([file]: File[]) => {
    setError('');
    clearResult();
    if (file.name.toLowerCase().endsWith('.txt')) {
      const text = await file.text();
      if (!text.trim()) {
        setError('That file is empty. Please choose a label text file with some content.');
        return;
      }
      setImage(null);
      setLabelText(text);
    } else {
      setLabelText('');
      setImage(file);
    }
  };

  const runCheck = async () => {
    setError('');
    clearResult();
    const id = ++run.current;

    if (image) {
      try {
        const r = await readLabelImage(image, {
          hints: { brand: app.brand, classType: app.classType },
          onStage: (s) => run.current === id && setBusy(s),
        });
        if (run.current !== id) return;
        setReading(r);
        setResult(verifyLabel(app, r.fields, { ocr: true, bold: r.bold }));
        const nothing = !r.rawText.trim();
        if (nothing) setError('No text could be read from this picture. Please try a clearer, straighter photo.');
      } catch (e) {
        if (run.current === id) setError(errorMessage(e));
      } finally {
        if (run.current === id) setBusy(null);
      }
      return;
    }

    if (labelText.trim()) {
      const fields = parseLabelText(labelText);
      const missing = missingLabelFields(fields);
      setTextRead({ ...fields });
      setResult(verifyLabel(app, fields));
      if (missing.length > 0) setError(`We could not find these in the label text: ${missing.join(', ')}.`);
      return;
    }

    setError('Please add the label first: choose a picture of the label (or a .txt file), or paste the label text.');
  };

  return (
    <div>
      <div className="row">
        <h2>1. Application details</h2>
        <label className="inline sample-pick">
          Try a sample:
          <select
            value=""
            onChange={(e) => e.target.value && loadSample(e.target.value)}
            aria-label="Load a built-in sample label"
          >
            <option value="">Choose…</option>
            {SAMPLES.map((s) => (
              <option key={s.file} value={s.file}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="form-grid">
        <label>
          Brand name
          <input value={app.brand} onChange={setField('brand')} />
        </label>
        <label>
          Class/type
          <input value={app.classType} onChange={setField('classType')} />
        </label>
        <label>
          Alcohol content (% by volume)
          <input value={app.abv} onChange={setField('abv')} inputMode="decimal" placeholder="e.g. 45" />
        </label>
        <label>
          Net contents
          <input value={app.netContents} onChange={setField('netContents')} placeholder="e.g. 750 mL" />
        </label>
        <label>
          Country of origin <span className="muted">(imports only)</span>
          <input value={app.origin} onChange={setField('origin')} />
        </label>
      </div>

      <h2>2. Label picture</h2>
      <FileDrop
        accept={[...IMAGE_TYPES, '.txt']}
        title="Upload a picture of the label"
        hint="A PNG or JPG photo or scan. (A .txt file of the label text also works.)"
        onFiles={onFiles}
        onError={setError}
      />

      {previewUrl && (
        <div className="preview">
          <img src={previewUrl} alt="The label picture you chose" />
          <p className="muted">{image?.name}</p>
        </div>
      )}
      {labelText && !image && <p className="muted">Using label text from the file you chose ({labelText.length} characters).</p>}

      <details className="paste-box">
        <summary>Have the label as text instead? Paste it here</summary>
        <label className="paste">
          Label text
          <textarea
            rows={6}
            value={labelText}
            onChange={(e) => {
              setImage(null);
              setLabelText(e.target.value);
              clearResult();
            }}
            placeholder={'Brand Name: ...\nClass/Type: ...\nAlcohol Content: ...\nNet Contents: ...\nGOVERNMENT WARNING: ...'}
          />
        </label>
      </details>

      <div className="actions">
        <button type="button" className="btn btn-primary btn-large" onClick={runCheck} disabled={busy !== null}>
          {busy ? 'Checking…' : 'Check this label'}
        </button>
        <button type="button" className="btn" onClick={clearAll}>
          Start over
        </button>
        <a className="btn" href={sampleUrl('images/label-01-pass.png')} download>
          Download a sample label picture
        </a>
      </div>

      {busy && (
        <p className="status" role="status">
          <span className="spinner" aria-hidden="true" /> {STAGE_TEXT[busy]}
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {result && <CheckList result={result} />}
      {reading && <ReadDetails reading={reading} file={image ?? undefined} />}
      {textRead && (
        <details className="read-back">
          <summary>What we read from the text</summary>
          <dl>
            {Object.entries(textRead).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v || <span className="muted">(not found)</span>}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
