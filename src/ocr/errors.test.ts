import { describe, expect, it } from 'vitest';
import { errorMessage } from './errors';

describe('errorMessage', () => {
  it('uses the message of a normal Error', () => {
    expect(errorMessage(new Error('Boom'))).toBe('Boom');
  });

  it('uses a plain string', () => {
    expect(errorMessage('Failed to load')).toBe('Failed to load');
  });

  it('never returns an empty message, whatever was thrown', () => {
    for (const thrown of [undefined, null, {}, 42, new Event('error'), { message: '' }]) {
      expect(errorMessage(thrown).length).toBeGreaterThan(20);
    }
  });

  it('explains the "server sent a web page instead of a script" failure', () => {
    const msg = errorMessage(new SyntaxError("Unexpected token '<'"));
    expect(msg).toContain('npm install');
  });
});
