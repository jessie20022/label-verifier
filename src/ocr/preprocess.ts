/** Longest side, in pixels, that we feed to the OCR engine. Bigger is slower, not better. */
export const MAX_SIDE = 1800;
/** Very small images are enlarged to about this size so the letters are readable. */
export const MIN_SIDE = 1200;
const MAX_UPSCALE = 2.5;

export type Rotation = 0 | 90 | 180 | 270;

/** Scale factor that brings the longest side into a range the OCR engine reads well. */
export function targetScale(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (longest > MAX_SIDE) return MAX_SIDE / longest;
  if (longest < MIN_SIDE) return Math.min(MAX_UPSCALE, MIN_SIDE / longest);
  return 1;
}

/**
 * Turn RGBA pixels into stretched greyscale, in place.
 * Greyscale removes colour distractions; the stretch makes faint or washed-out
 * labels use the full dark-to-light range, which helps the OCR engine pick the text out.
 */
export function greyscaleAndStretch(
  data: Uint8ClampedArray,
  between?: (grey: Uint8ClampedArray) => void
): void {
  const px = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(
      0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    );
  }
  between?.(data);
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) hist[data[i]]++;
  const clip = Math.max(1, Math.floor(px * 0.01));
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < clip; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < clip; hi--);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.max(
      0,
      Math.min(255, Math.round(((data[i] - lo) * 255) / span))
    );
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
}

const FLAT_BLOCK = 64;
/** Images darker than this overall (light text on a dark label) are not flattened. */
const DARK_IMAGE_MEDIAN = 100;

/**
 * Even out lighting: estimate how bright the paper is in each 64 px block (the 90th
 * percentile, which ignores the ink) and divide it out, so a shadow, a gradient or a dark
 * table around the label stops hiding text. Expects greyscale in the red channel.
 * Skipped for mostly dark images, where the "paper" is the ink.
 */
export function flattenBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number
): void {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4 * 7) hist[data[i]]++;
  let total = 0;
  for (const c of hist) total += c;
  let acc = 0;
  let median = 0;
  while (median < 255 && (acc += hist[median]) < total / 2) median++;
  if (median < DARK_IMAGE_MEDIAN) return;

  const gx = Math.ceil(width / FLAT_BLOCK);
  const gy = Math.ceil(height / FLAT_BLOCK);
  const grid = new Float32Array(gx * gy);
  const bins = new Uint32Array(256);
  for (let by = 0; by < gy; by++) {
    for (let bx = 0; bx < gx; bx++) {
      bins.fill(0);
      let n = 0;
      const xe = Math.min(width, (bx + 1) * FLAT_BLOCK);
      const ye = Math.min(height, (by + 1) * FLAT_BLOCK);
      for (let y = by * FLAT_BLOCK; y < ye; y++) {
        for (let x = bx * FLAT_BLOCK; x < xe; x++) {
          bins[data[(y * width + x) * 4]]++;
          n++;
        }
      }
      let c = 0;
      let v = 255;
      while (v > 0 && (c += bins[v]) < n * 0.1) v--;
      grid[by * gx + bx] = v;
    }
  }

  const at = (x: number, y: number) =>
    grid[
      Math.max(0, Math.min(gy - 1, y)) * gx + Math.max(0, Math.min(gx - 1, x))
    ];
  for (let y = 0; y < height; y++) {
    const fy = y / FLAT_BLOCK - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = x / FLAT_BLOCK - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      const paper = Math.max(40, top * (1 - ty) + bottom * ty);
      const i = (y * width + x) * 4;
      data[i] = Math.min(255, (data[i] * 255) / paper);
    }
  }
}

/**
 * Draw the image onto a new canvas, scaled, turned clockwise by `rotation` plus a small
 * `tilt` correction (degrees), and cleaned up. The canvas grows to hold the turned image.
 */
export function renderForOcr(
  source: ImageBitmap,
  rotation: Rotation,
  tilt = 0
): HTMLCanvasElement {
  const scale = targetScale(source.width, source.height);
  const w = Math.round(source.width * scale);
  const h = Math.round(source.height * scale);
  const angle = ((rotation + tilt) * Math.PI) / 180;
  // Round away floating-point fuzz so quarter turns give exact sizes.
  const cos = Math.round(Math.abs(Math.cos(angle)) * 1e6) / 1e6;
  const sin = Math.round(Math.abs(Math.sin(angle)) * 1e6) / 1e6;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * cos + h * sin);
  canvas.height = Math.ceil(w * sin + h * cos);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser could not prepare the image.");

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(angle);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  greyscaleAndStretch(img.data, (grey) =>
    flattenBackground(grey, canvas.width, canvas.height)
  );
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Adaptive thresholding.
 *
 * Converts the image into black and white using the local
 * brightness around each pixel rather than one global threshold.
 *
 * Useful for labels with shadows and uneven lighting.
 */
export function adaptiveThreshold(
  source: HTMLCanvasElement,
  radius = 21,
  offset = 10
): HTMLCanvasElement {
  const width = source.width;
  const height = source.height;

  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;

  const sourceCtx = source.getContext("2d", {
    willReadFrequently: true,
  });

  const outputCtx = output.getContext("2d", {
    willReadFrequently: true,
  });

  if (!sourceCtx || !outputCtx) {
    throw new Error("Could not prepare image for OCR.");
  }

  const image = sourceCtx.getImageData(0, 0, width, height);
  const pixels = image.data;

  // Integral image allows fast local brightness calculations.
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));

  for (let y = 1; y <= height; y++) {
    let rowSum = 0;

    for (let x = 1; x <= width; x++) {
      const i = ((y - 1) * width + (x - 1)) * 4;

      const grey =
        0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];

      rowSum += grey;

      integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
    }
  }

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(height - 1, y + radius);

    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(width - 1, x + radius);

      const area = (x2 - x1 + 1) * (y2 - y1 + 1);

      const sum =
        integral[(y2 + 1) * stride + (x2 + 1)] -
        integral[y1 * stride + (x2 + 1)] -
        integral[(y2 + 1) * stride + x1] +
        integral[y1 * stride + x1];

      const localMean = sum / area;

      const i = (y * width + x) * 4;

      const grey =
        0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];

      const value = grey < localMean - offset ? 0 : 255;

      pixels[i] = value;
      pixels[i + 1] = value;
      pixels[i + 2] = value;
      pixels[i + 3] = 255;
    }
  }

  outputCtx.putImageData(image, 0, 0);

  return output;
}
