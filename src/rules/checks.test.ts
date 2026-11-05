import { describe, expect, it } from 'vitest';
import {
  WARNING,
  checkAbv,
  checkBrand,
  checkNetContents,
  checkOrigin,
  checkWarning,
} from './checks';
import { parseVolumeMl } from './normalize';
import { verifyLabel } from './verify';

describe('checkBrand', () => {
  it('passes on an exact match', () => {
    expect(checkBrand('OLD TOM DISTILLERY', 'OLD TOM DISTILLERY').status).toBe('pass');
  });

  it("flags STONE'S THROW vs Stone's Throw for review, not failure", () => {
    expect(checkBrand("Stone's Throw", "STONE'S THROW").status).toBe('review');
  });

  it('treats punctuation-only differences as review', () => {
    expect(checkBrand("Stones Throw", "Stone's Throw").status).toBe('review');
  });

  it('fails on a real difference', () => {
    expect(checkBrand('Old Tom', 'Young Tom').status).toBe('fail');
  });

  it('fails when the label value is empty', () => {
    expect(checkBrand('Old Tom', '').status).toBe('fail');
  });

  it('ignores extra whitespace', () => {
    expect(checkBrand('Old  Tom', ' Old Tom ').status).toBe('pass');
  });
});

describe('checkAbv', () => {
  it('passes when percent and proof agree', () => {
    expect(checkAbv('45', '45% Alc./Vol. (90 Proof)').status).toBe('pass');
  });

  it('accepts a % sign in the application value', () => {
    expect(checkAbv('45%', '45% Alc./Vol.').status).toBe('pass');
  });

  it('fails when the percentages differ', () => {
    const r = checkAbv('40', '45% Alc./Vol.');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('45%');
  });

  it("fails when proof isn't double the percentage", () => {
    expect(checkAbv('45', '45% Alc./Vol. (80 Proof)').status).toBe('fail');
  });

  it('fails when no ABV is on the label', () => {
    expect(checkAbv('45', 'Kentucky Bourbon').status).toBe('fail');
  });

  it('fails when the application ABV is empty', () => {
    expect(checkAbv('', '45% Alc./Vol.').status).toBe('fail');
  });

  it('handles decimals', () => {
    expect(checkAbv('12.5', '12.5% alc/vol').status).toBe('pass');
  });
});

describe('checkNetContents', () => {
  it('passes on identical text', () => {
    expect(checkNetContents('750 mL', '750 mL').status).toBe('pass');
  });

  it('treats 750ml, 75 cl and 0.75 L as the same volume', () => {
    expect(checkNetContents('750 mL', '750ml').status).toBe('pass');
    expect(checkNetContents('750 mL', '75 cl').status).toBe('pass');
    expect(checkNetContents('750 mL', '0.75 L').status).toBe('pass');
  });

  it('fails on a different volume', () => {
    expect(checkNetContents('750 mL', '1 L').status).toBe('fail');
  });

  it('fails when a volume cannot be read', () => {
    expect(checkNetContents('750 mL', 'a big bottle').status).toBe('fail');
  });

  it('parses fluid ounces', () => {
    expect(parseVolumeMl('12 fl oz')).toBeCloseTo(354.88, 1);
  });
});

describe('checkOrigin', () => {
  it('is not applicable when neither side has an origin', () => {
    expect(checkOrigin('', '').status).toBe('pass');
  });

  it('fails when an import is missing the origin on the label', () => {
    expect(checkOrigin('Scotland', '').status).toBe('fail');
  });

  it('passes when origins match', () => {
    expect(checkOrigin('Scotland', 'Scotland').status).toBe('pass');
  });

  it('accepts "Product of Scotland" for Scotland', () => {
    expect(checkOrigin('Scotland', 'Product of Scotland').status).toBe('pass');
  });

  it('fails a different country', () => {
    expect(checkOrigin('Scotland', 'Ireland').status).toBe('fail');
  });

  it('sends an unexpected label origin to review', () => {
    expect(checkOrigin('', 'Product of USA').status).toBe('review');
  });
});

describe('checkWarning', () => {
  it('passes on the exact standard text', () => {
    expect(checkWarning(WARNING).status).toBe('pass');
  });

  it('tolerates line breaks and extra spaces', () => {
    const wrapped = WARNING.replace('(2)', '\n(2)').replace('women', '  women');
    expect(checkWarning(wrapped).status).toBe('pass');
  });

  it('fails a title-case "Government Warning:" header', () => {
    const r = checkWarning(WARNING.replace('GOVERNMENT WARNING:', 'Government Warning:'));
    expect(r.status).toBe('fail');
    expect(r.message).toContain('all capital');
  });

  it('fails altered wording and points at the word', () => {
    const r = checkWarning(WARNING.replace('Surgeon General', 'Doctor'));
    expect(r.status).toBe('fail');
    expect(r.message).toContain('Doctor');
  });

  it('fails when the warning is missing', () => {
    expect(checkWarning('').status).toBe('fail');
  });

  it('fails when truncated', () => {
    expect(checkWarning(WARNING.slice(0, 80)).status).toBe('fail');
  });
});

describe('verifyLabel', () => {
  const app = {
    brand: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    abv: '45',
    netContents: '750 mL',
    origin: '',
  };
  const label = {
    brand: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    abv: '45% Alc./Vol. (90 Proof)',
    netContents: '750 mL',
    origin: '',
    warning: WARNING,
  };

  it('passes a fully matching label', () => {
    expect(verifyLabel(app, label).overall).toBe('pass');
  });

  it('rolls up to review when only a review-level issue exists', () => {
    expect(verifyLabel({ ...app, brand: 'Old Tom Distillery' }, label).overall).toBe('review');
  });

  it('rolls up to the worst status', () => {
    const r = verifyLabel({ ...app, brand: 'Old Tom Distillery' }, { ...label, abv: '40%' });
    expect(r.overall).toBe('fail');
    expect(r.checks).toHaveLength(6);
  });
});
