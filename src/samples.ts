import type { Application } from './rules/types';

export interface SampleLabel {
  file: string;
  title: string;
  app: Application;
  /** What a correct run should report, shown to testers. */
  expect: string;
}

const app = (brand: string, classType: string, abv: string, netContents: string, origin = ''): Application => ({
  brand,
  classType,
  abv,
  netContents,
  origin,
});

/** Built-in test labels (see public/samples/images). Keep in step with tools/make_samples.py. */
export const SAMPLES: SampleLabel[] = [
  {
    file: 'label-01-pass.png',
    title: '1. Everything matches',
    app: app('OLD TOM DISTILLERY', 'Kentucky Straight Bourbon Whiskey', '45', '750 mL'),
    expect: 'Pass',
  },
  {
    file: 'label-02-case-difference.png',
    title: "2. STONE'S THROW vs Stone's Throw",
    app: app("Stone's Throw", 'Straight Rye Whiskey', '50', '750 mL'),
    expect: 'Needs review (capitalization only)',
  },
  {
    file: 'label-03-titlecase-warning.png',
    title: '3. Warning header in title case',
    app: app('Harbor Light Vodka', 'Vodka', '40', '1 L'),
    expect: 'Fail (header must be all caps)',
  },
  {
    file: 'label-04-wrong-abv.png',
    title: '4. Alcohol content does not match',
    app: app('Copper Ridge', 'Single Malt Whisky', '43', '700 mL', 'Scotland'),
    expect: 'Fail (label 46%, application 43%)',
  },
  {
    file: 'label-05-altered-warning.png',
    title: '5. Warning wording changed',
    app: app('Sunset Rum', 'Spiced Rum', '35', '750 mL'),
    expect: 'Fail (extra word "may")',
  },
  {
    file: 'label-06-import-ok.png',
    title: '6. Import, 75 cl = 750 mL',
    app: app('Pine Hollow', 'Blended Scotch Whisky', '40', '750 mL', 'Scotland'),
    expect: 'Pass',
  },
  {
    file: 'label-07-missing-warning.png',
    title: '7. No government warning',
    app: app('Redwood Tequila', 'Tequila Reposado', '40', '750 mL', 'Mexico'),
    expect: 'Fail (warning missing)',
  },
  {
    file: 'label-08-glare-skew.jpg',
    title: '8. Photo: tilted, glare, blur',
    app: app('Bluewater Gin', 'London Dry Gin', '47', '750 mL', 'England'),
    expect: 'Pass (or review if the photo is misread)',
  },
  {
    file: 'label-09-rotated-sideways.png',
    title: '9. Photographed sideways',
    app: app('Silver Creek', 'Blended Canadian Whisky', '40', '750 mL', 'Canada'),
    expect: 'Pass (image is turned automatically)',
  },
  {
    file: 'label-10-header-not-bold.png',
    title: '10. Warning header not bold',
    app: app('Granite Peak', 'Bourbon Whiskey', '47.5', '750 mL'),
    expect: 'Needs review (header not bold)',
  },
];

export const sampleUrl = (path: string): string => `${import.meta.env.BASE_URL}samples/${path}`;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  csv: 'text/csv',
};

/** Download one of the built-in sample files and wrap it as a File, as if the user had chosen it. */
export async function fetchSampleFile(path: string): Promise<File> {
  const res = await fetch(sampleUrl(path));
  if (!res.ok) throw new Error(`Could not load the sample file ${path}.`);
  const blob = await res.blob();
  const name = path.split('/').pop() ?? path;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return new File([blob], name, { type: MIME[ext] ?? blob.type });
}
