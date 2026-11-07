import { validateConfig } from '../src/config/configuration';

const base = { STORAGE_DRIVER: 'memory', JWT_SECRET: 'x'.repeat(32) };
describe('PDF analysis configuration', () => {
  it('keeps existing deployments on legacy and provides bounded local defaults', () => {
    const config = validateConfig(base);
    expect(config.PDF_ANALYSIS_MODE).toBe('legacy');
    expect(config.PDF_ANALYSIS_URL).toBe('http://127.0.0.1:8091');
    expect(config.PDF_ANALYSIS_TIMEOUT_MS).toBe(95000);
    expect(config.PDF_ANALYSIS_NATIVE_FAST_PATH).toBe(true);
  });
  it('allows disabling the native vector shortcut explicitly', () => {
    expect(validateConfig({ ...base, PDF_ANALYSIS_NATIVE_FAST_PATH: 'false' }).PDF_ANALYSIS_NATIVE_FAST_PATH).toBe(false);
    expect(() => validateConfig({ ...base, PDF_ANALYSIS_NATIVE_FAST_PATH: 'sometimes' })).toThrow();
  });
  it('rejects misspelled modes, invalid URLs and unbounded timeouts', () => {
    for (const value of [{ PDF_ANALYSIS_MODE: 'fast' }, { PDF_ANALYSIS_URL: 'file:///tmp' },
      { PDF_ANALYSIS_TIMEOUT_MS: 0 }, { PDF_ANALYSIS_TIMEOUT_MS: 600001 }])
      expect(() => validateConfig({ ...base, ...value })).toThrow();
    expect(validateConfig({ ...base, PDF_ANALYSIS_MODE: 'hybrid' }).PDF_ANALYSIS_MODE).toBe('hybrid');
  });
});
