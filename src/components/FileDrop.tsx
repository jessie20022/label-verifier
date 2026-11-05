import { useRef, useState } from 'react';

interface Props {
  /** Allowed extensions, lower-case, with the dot: ['.csv', '.png'] */
  accept: string[];
  title: string;
  /** Plain-language description of what to choose, shown under the title. */
  hint?: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  onError: (message: string) => void;
}

export function FileDrop({ accept, title, hint, multiple = false, onFiles, onError }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const handle = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const all = Array.from(list);
    const good = all.filter((f) => accept.some((ext) => f.name.toLowerCase().endsWith(ext)));
    const bad = all.filter((f) => !good.includes(f));
    if (good.length === 0) {
      onError(`Please choose a ${accept.join(', ')} file. "${bad[0].name}" is not supported.`);
      return;
    }
    if (bad.length > 0) {
      onError(`Skipped ${bad.length} unsupported file${bad.length === 1 ? '' : 's'}, such as "${bad[0].name}".`);
    }
    onFiles(multiple ? good : good.slice(0, 1));
  };

  return (
    <div
      className={`drop ${over ? 'drop-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        handle(e.dataTransfer.files);
      }}
    >
      <p className="drop-title">{title}</p>
      {hint && <p className="muted">{hint}</p>}
      <p className="muted">Drag {multiple ? 'the files' : 'the file'} here, or</p>
      <button type="button" className="btn btn-primary" onClick={() => input.current?.click()}>
        {multiple ? 'Choose files' : 'Choose a file'}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept.join(',')}
        multiple={multiple}
        hidden
        onChange={(e) => {
          handle(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
