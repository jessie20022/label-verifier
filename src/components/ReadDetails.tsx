import { useEffect, useState } from 'react';
import type { LabelReading } from '../ocr/types';

const NAMES: Array<[keyof LabelReading['fields'], string]> = [
  ['brand', 'Brand name'],
  ['classType', 'Class/type'],
  ['abv', 'Alcohol content'],
  ['netContents', 'Net contents'],
  ['origin', 'Country of origin'],
  ['warning', 'Government warning'],
];

function Picture({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <img className="read-img" src={url} alt={`Label image ${file.name}`} /> : null;
}

/** Shows exactly what was read from a label image, so an agent can see why a check passed or failed. */
export function ReadDetails({ reading, file, label = 'What we read from the image' }: { reading: LabelReading; file?: File; label?: string }) {
  const [open, setOpen] = useState(false);
  const hard = reading.confidence < 70;
  return (
    <details className="read-back" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{label}</summary>
      {open && (
        <div className="read-grid">
          {file && <Picture file={file} />}
          <div>
            <p className="muted">
              Read in {reading.seconds.toFixed(1)} s, confidence {reading.confidence}%
              {reading.rotation ? `, picture turned ${reading.rotation}°` : ''}
              {reading.deskew ? `, straightened by ${reading.deskew}°` : ''}.
              {reading.bold.ratio !== null && ` Header thickness ratio ${reading.bold.ratio} (bold if at least 1.2).`}
              {hard && ' This picture was hard to read. A clearer, straighter photo may give better results.'}
            </p>
            <dl>
              {NAMES.map(([key, name]) => (
                <div key={key}>
                  <dt>{name}</dt>
                  <dd>{reading.fields[key] || <span className="muted">(not found)</span>}</dd>
                </div>
              ))}
            </dl>
            <details>
              <summary>All the text the reader saw</summary>
              <pre className="raw">{reading.rawText}</pre>
            </details>
          </div>
        </div>
      )}
    </details>
  );
}
