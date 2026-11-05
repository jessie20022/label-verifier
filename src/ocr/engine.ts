import { OEM, PSM, createScheduler, createWorker } from 'tesseract.js';
import type { Scheduler } from 'tesseract.js';
import type { OcrLine, OcrPage } from './types';
import { errorMessage } from './errors';

// Everything the OCR engine needs is served from this site (see scripts/copy-ocr-assets.mjs),
// so reading a label never contacts another server.
const BASE = `${import.meta.env.BASE_URL}tesseract`;

let scheduler: Scheduler | null = null;
let workerCount = 0;
let starting: Promise<void> | null = null;

/** Number of parallel OCR workers worth running on this computer. */
export function recommendedWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(4, cores - 1));
}

/** How long the reader may take to start before we give up and say so. */
const START_TIMEOUT_MS = 90_000;

/** Make sure the engine files are really there. A missing file is often answered with a web page. */
let filesChecked: Promise<void> | null = null;
function checkEngineFiles(): Promise<void> {
  filesChecked ??= (async () => {
    for (const name of ['worker.min.js', 'eng.traineddata.gz']) {
      let res: Response;
      try {
        res = await fetch(`${BASE}/${name}`, { method: 'HEAD' });
      } catch {
        throw new Error(`The reader's files could not be reached (${BASE}/${name}). Check your connection and reload the page.`);
      }
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || type.includes('text/html')) {
        throw new Error(
          `The reader's file "${name}" is missing from this site. If you are running this on your computer, stop it, run "npm install", then start it again with "npm run dev". If this is the published site, it needs to be rebuilt.`,
        );
      }
    }
  })().catch((e) => {
    filesChecked = null; // allow a retry after the problem is fixed
    throw e;
  });
  return filesChecked;
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function addWorkers(target: number): Promise<void> {
  const needed = target - workerCount;
  if (needed <= 0) return;
  await checkEngineFiles();
  scheduler ??= createScheduler();
  const sched = scheduler;
  workerCount = target;
  try {
    const created = await withTimeout(
      Promise.all(
        Array.from({ length: needed }, async () => {
          const worker = await createWorker('eng', OEM.LSTM_ONLY, {
            workerPath: `${BASE}/worker.min.js`,
            corePath: BASE,
            langPath: BASE,
            gzip: true,
            workerBlobURL: false,
          });
          // PSM 3 = fully automatic page segmentation; fine for labels with several text blocks.
          await worker.setParameters({
            tessedit_pageseg_mode: PSM.AUTO,
            preserve_interword_spaces: '1',
            user_defined_dpi: '300',
          });
          return worker;
        }),
      ),
      START_TIMEOUT_MS,
      'The reader took too long to start. Reload the page and try again.',
    );
    created.forEach((w) => sched.addWorker(w));
  } catch (e) {
    workerCount -= needed;
    throw new Error(errorMessage(e));
  }
}

/** Start the OCR engine (first call loads about 7 MB from this site; later calls are instant). */
export function ensureEngine(workers = 1): Promise<void> {
  const attempt = (starting ?? Promise.resolve()).then(() => addWorkers(workers));
  // Keep the chain usable even if this attempt fails, so a later call can try again.
  starting = attempt.catch(() => undefined);
  return attempt;
}

type RawBlock = {
  paragraphs?: Array<{
    lines?: Array<{
      text: string;
      confidence: number;
      bbox: OcrLine['bbox'];
      baseline?: OcrLine['bbox'];
      words?: OcrLine['words'];
    }>;
  }>;
};

/** Read all the text on a prepared canvas, with where each line and word sits. */
export async function recognize(canvas: HTMLCanvasElement): Promise<OcrPage> {
  if (!scheduler || workerCount === 0) await ensureEngine(1);
  const result = await scheduler!.addJob('recognize', canvas, {}, { text: true, blocks: true });
  const data = result.data;

  const lines: OcrLine[] = [];
  for (const block of (data.blocks ?? []) as unknown as RawBlock[]) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const text = line.text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        lines.push({
          text,
          confidence: line.confidence,
          bbox: line.bbox,
          baseline: line.baseline,
          words: (line.words ?? []).map((w) => ({
            text: w.text,
            confidence: w.confidence,
            bbox: w.bbox,
          })),
        });
      }
    }
  }
  return { lines, text: data.text ?? '', width: canvas.width, height: canvas.height };
}

/** Free the worker threads (used when leaving the page or in tests). */
export async function shutdownEngine(): Promise<void> {
  const s = scheduler;
  scheduler = null;
  workerCount = 0;
  starting = null;
  if (s) await s.terminate();
}
