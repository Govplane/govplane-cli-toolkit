import { describe, expect, it } from '@jest/globals';
import { maskEmail } from '../../src/activation/mask.js';

describe('maskEmail', () => {
  it('keeps the local part and drops the domain', () => {
    expect(maskEmail('dev@example.com')).toBe('dev@*******');
  });

  it('masks the domain to a fixed width, so its length is not leaked', () => {
    expect(maskEmail('a@x.io')).toBe('a@*******');
    expect(maskEmail('a@a-very-long-corporate-domain.example.co.uk')).toBe('a@*******');
  });

  it('splits on the last @, so a quoted local part survives intact', () => {
    expect(maskEmail('"odd@name"@example.com')).toBe('"odd@name"@*******');
  });

  it('masks the whole value when the shape is not an address', () => {
    // Never widen what gets printed on the strength of a guess about the format.
    expect(maskEmail('not-an-email')).toBe('*******');
    expect(maskEmail('@example.com')).toBe('*******');
    expect(maskEmail('dev@')).toBe('*******');
    expect(maskEmail('')).toBe('*******');
  });

  it('ignores surrounding whitespace', () => {
    expect(maskEmail('  dev@example.com  ')).toBe('dev@*******');
  });

  it('never returns the domain in any form', () => {
    expect(maskEmail('dev@example.com')).not.toContain('example');
    expect(maskEmail('dev@example.com')).not.toContain('.com');
  });
});
