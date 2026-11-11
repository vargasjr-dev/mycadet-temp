/**
 * Tests for the canonical extension environment contract.
 *
 * Covers:
 *   - parseExtensionEnvironment: alias normalization, trimming, case-
 *     insensitivity, and rejection of invalid values.
 *   - resolveBuildDefaultEnvironment: fallback to 'production' when the
 *     bundler-defined env var is missing or invalid.
 *   - cloudBaseUrlForEnvironment: the single-origin mapping for every
 *     supported environment.
 */

import { describe, test, expect, afterEach } from 'bun:test';

import {
  parseExtensionEnvironment,
  resolveBuildDefaultEnvironment,
  cloudBaseUrlForEnvironment,
  createFirstAssistantUrl,
  CREATE_ASSISTANT_WEB_PATH,
  type ExtensionEnvironment,
} from '../extension-environment.js';

// ── parseExtensionEnvironment ───────────────────────────────────────

describe('parseExtensionEnvironment', () => {
  test('parses each canonical environment value', () => {
    expect(parseExtensionEnvironment('local')).toBe('local');
    expect(parseExtensionEnvironment('dev')).toBe('dev');
    expect(parseExtensionEnvironment('staging')).toBe('staging');
    expect(parseExtensionEnvironment('production')).toBe('production');
  });

  test('"prod" is an alias for "production"', () => {
    expect(parseExtensionEnvironment('prod')).toBe('production');
  });

  test('is case-insensitive', () => {
    expect(parseExtensionEnvironment('LOCAL')).toBe('local');
    expect(parseExtensionEnvironment('Dev')).toBe('dev');
    expect(parseExtensionEnvironment('STAGING')).toBe('staging');
    expect(parseExtensionEnvironment('PRODUCTION')).toBe('production');
    expect(parseExtensionEnvironment('Prod')).toBe('production');
    expect(parseExtensionEnvironment('PROD')).toBe('production');
  });

  test('trims whitespace', () => {
    expect(parseExtensionEnvironment('  dev  ')).toBe('dev');
    expect(parseExtensionEnvironment('\tproduction\n')).toBe('production');
    expect(parseExtensionEnvironment(' prod ')).toBe('production');
  });

  test('returns null for undefined', () => {
    expect(parseExtensionEnvironment(undefined)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseExtensionEnvironment('')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(parseExtensionEnvironment('   ')).toBeNull();
    expect(parseExtensionEnvironment('\t')).toBeNull();
  });

  test('returns null for unrecognized values', () => {
    expect(parseExtensionEnvironment('test')).toBeNull();
    expect(parseExtensionEnvironment('unknown')).toBeNull();
    expect(parseExtensionEnvironment('release')).toBeNull();
    expect(parseExtensionEnvironment('development')).toBeNull();
    expect(parseExtensionEnvironment('prod-us')).toBeNull();
  });
});

// ── resolveBuildDefaultEnvironment ──────────────────────────────────

describe('resolveBuildDefaultEnvironment', () => {
  const savedEnv = process.env.CADET_ENVIRONMENT;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CADET_ENVIRONMENT;
    } else {
      process.env.CADET_ENVIRONMENT = savedEnv;
    }
  });

  test('returns the environment when CADET_ENVIRONMENT is a valid value', () => {
    process.env.CADET_ENVIRONMENT = 'staging';
    expect(resolveBuildDefaultEnvironment()).toBe('staging');
  });

  test('resolves "prod" alias via build env', () => {
    process.env.CADET_ENVIRONMENT = 'prod';
    expect(resolveBuildDefaultEnvironment()).toBe('production');
  });

  test('falls back to "production" when CADET_ENVIRONMENT is unset', () => {
    delete process.env.CADET_ENVIRONMENT;
    expect(resolveBuildDefaultEnvironment()).toBe('production');
  });

  test('falls back to "production" when CADET_ENVIRONMENT is empty', () => {
    process.env.CADET_ENVIRONMENT = '';
    expect(resolveBuildDefaultEnvironment()).toBe('production');
  });

  test('falls back to "production" when CADET_ENVIRONMENT is invalid', () => {
    process.env.CADET_ENVIRONMENT = 'bogus';
    expect(resolveBuildDefaultEnvironment()).toBe('production');
  });
});

// ── cloudBaseUrlForEnvironment ──────────────────────────────────────

describe('cloudBaseUrlForEnvironment', () => {
  const cases: Array<{ env: ExtensionEnvironment; expectedBaseUrl: string }> = [
    { env: 'production', expectedBaseUrl: 'https://mycadet.ai' },
    { env: 'staging', expectedBaseUrl: 'https://staging.mycadet.ai' },
    { env: 'dev', expectedBaseUrl: 'https://dev.mycadet.ai' },
    { env: 'local', expectedBaseUrl: 'http://localhost:7840' },
  ];

  for (const { env, expectedBaseUrl } of cases) {
    test(`${env}: baseUrl is ${expectedBaseUrl}`, () => {
      expect(cloudBaseUrlForEnvironment(env)).toBe(expectedBaseUrl);
    });
  }
});

describe('createFirstAssistantUrl', () => {
  const cases: Array<{ env: ExtensionEnvironment; baseUrl: string }> = [
    { env: 'production', baseUrl: 'https://mycadet.ai' },
    { env: 'staging', baseUrl: 'https://staging.mycadet.ai' },
    { env: 'dev', baseUrl: 'https://dev.mycadet.ai' },
    { env: 'local', baseUrl: 'http://localhost:7840' },
  ];

  for (const { env, baseUrl } of cases) {
    test(`${env} opens the hatching entry on ${baseUrl}`, () => {
      expect(createFirstAssistantUrl(env)).toBe(
        `${baseUrl}${CREATE_ASSISTANT_WEB_PATH}`,
      );
    });
  }

  test('points at the cloud hatching route, not the local-only chooser create action', () => {
    expect(CREATE_ASSISTANT_WEB_PATH).toBe('/assistant/onboarding/hatching');
  });
});
