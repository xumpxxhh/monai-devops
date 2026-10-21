import { describe, expect, it } from 'vitest';
import { parseSecretRefLines } from './secret-ref-lines';

describe('parseSecretRefLines', () => {
  it('parses environment references without exposing resolved values', () => {
    expect(
      parseSecretRefLines('apiKey=secret://env/CORE3_DEV_SECRET\nother = secret://env/OTHER'),
    ).toEqual({
      apiKey: 'secret://env/CORE3_DEV_SECRET',
      other: 'secret://env/OTHER',
    });
  });

  it.each([
    'apiKey=plaintext',
    'apiKey=secret://project/key',
    'apiKey=secret://env/X\napiKey=secret://env/Y',
  ])('rejects invalid references', (input) => {
    expect(() => parseSecretRefLines(input)).toThrow();
  });
});
