import { validateConfig } from '../src/config/configuration';

const base = { STORAGE_DRIVER: 'memory', JWT_SECRET: 'x'.repeat(32) };
describe('PDF analysis configuration', () => {
  it('provides bounded local defaults without a production mode switch', () => {
    const config = validateConfig(base);
    expect(config.PDF_ANALYSIS_MODE).toBeUndefined();
    expect(config.PDF_ANALYSIS_URL).toBe('http://127.0.0.1:8091');
    expect(config.PDF_ANALYSIS_TIMEOUT_MS).toBe(95000);
    expect(config.PDF_ANALYSIS_NATIVE_FAST_PATH).toBeUndefined();
  });
  it('accepts old environment keys for migration without honoring them', () => {
    const config = validateConfig({
      ...base, PDF_ANALYSIS_MODE: 'legacy', PDF_ANALYSIS_NATIVE_FAST_PATH: 'false',
    });
    expect(config.PDF_ANALYSIS_MODE).toBeUndefined();
    expect(config.PDF_ANALYSIS_NATIVE_FAST_PATH).toBeUndefined();
  });
  it('rejects misspelled modes, invalid URLs and unbounded timeouts', () => {
    for (const value of [{ PDF_ANALYSIS_URL: 'file:///tmp' },
      { PDF_ANALYSIS_TIMEOUT_MS: 0 }, { PDF_ANALYSIS_TIMEOUT_MS: 600001 }])
      expect(() => validateConfig({ ...base, ...value })).toThrow();
  });
});
