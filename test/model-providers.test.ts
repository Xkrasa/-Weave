import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadDotEnv, loadDotEnvFile } from '../src/core/dotenv.ts'
import { resolveApiKey, resolveEndpoint } from '../src/core/model.ts'
import { resolveTaskConfig } from '../src/core/model-policy.ts'
import type { ModelConfig } from '../src/core/types.ts'

function baseConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    model: 'glm-5.3',
    baseUrl: 'http://127.0.0.1:7863/v1',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    safetyMarginTokens: 2000,
    charsPerToken: 1.6,
    temperature: 0.8,
    timeoutMs: 180000,
    snapshotEvery: 10,
    ...overrides,
  }
}

test('loadDotEnv fills unset variables and never overrides the environment', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-dotenv-'))
  const appliedKey = 'WEAVE_TEST_DOTENV_APPLIED'
  const keptKey = 'WEAVE_TEST_DOTENV_KEPT'
  const quotedKey = 'WEAVE_TEST_DOTENV_QUOTED'
  delete process.env[appliedKey]
  delete process.env[quotedKey]
  process.env[keptKey] = 'from-shell'
  try {
    await writeFile(path.join(dir, '.env'), [
      '# comment line',
      `${appliedKey}=from-file`,
      `${keptKey}=from-file`,
      `${quotedKey}="quoted value"`,
      'INVALID LINE WITHOUT EQUALS',
      '',
    ].join('\n'), 'utf8')
    const applied = await loadDotEnv(dir)
    assert.equal(process.env[appliedKey], 'from-file')
    assert.equal(process.env[keptKey], 'from-shell')
    assert.equal(process.env[quotedKey], 'quoted value')
    assert.deepEqual(applied, [appliedKey, quotedKey])
  } finally {
    delete process.env[appliedKey]
    delete process.env[keptKey]
    delete process.env[quotedKey]
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadDotEnv is a no-op when the file is absent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-dotenv-empty-'))
  try {
    assert.deepEqual(await loadDotEnv(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadDotEnvFile reads an explicit path instead of the working directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-dotenv-explicit-'))
  const key = 'WEAVE_TEST_DOTENV_EXPLICIT'
  delete process.env[key]
  try {
    const file = path.join(dir, 'secrets.env')
    await writeFile(file, `${key}=explicit-value\n`, 'utf8')
    assert.deepEqual(await loadDotEnvFile(file), [key])
    assert.equal(process.env[key], 'explicit-value')
  } finally {
    delete process.env[key]
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveApiKey reads the configured env var and defaults to WEAVE_API_KEY', () => {
  const previous = process.env.WEAVE_API_KEY
  process.env.WEAVE_TEST_PROVIDER_KEY = 'provider-key'
  process.env.WEAVE_API_KEY = 'default-key'
  try {
    assert.equal(resolveApiKey(baseConfig({ apiKeyEnv: 'WEAVE_TEST_PROVIDER_KEY' })), 'provider-key')
    assert.equal(resolveApiKey(baseConfig()), 'default-key')
    assert.equal(resolveApiKey(baseConfig({ apiKeyEnv: 'WEAVE_TEST_MISSING_KEY' })), '')
  } finally {
    delete process.env.WEAVE_TEST_PROVIDER_KEY
    if (previous === undefined) delete process.env.WEAVE_API_KEY
    else process.env.WEAVE_API_KEY = previous
  }
})

test('resolveEndpoint completes the Google compatibility path and rejects unimplemented providers', () => {
  assert.equal(
    resolveEndpoint(baseConfig()),
    'http://127.0.0.1:7863/v1/chat/completions',
  )
  assert.equal(
    resolveEndpoint(baseConfig({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/', provider: 'google' })),
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  )
  assert.equal(
    resolveEndpoint(baseConfig({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', provider: 'google' })),
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  )
  assert.throws(
    () => resolveEndpoint(baseConfig({ provider: 'anthropic' })),
    /anthropic/,
  )
})

test('resolveTaskConfig keeps legacy purpose fields and default behaviour intact', () => {
  const config = baseConfig({ extractionModel: 'legacy-extract' })
  assert.equal(resolveTaskConfig(config, 'extraction').model, 'legacy-extract')
  assert.equal(resolveTaskConfig(config, 'writing').model, 'glm-5.3')
  assert.equal(resolveTaskConfig(config, 'writing').provider, undefined)
})

test('resolveTaskConfig applies provider and key overrides per task only', () => {
  const config = baseConfig({
    apiKeyEnv: 'WEAVE_API_KEY',
    taskModels: {
      extraction: {
        model: 'gemini-2.5-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKeyEnv: 'Google_API_KEY',
        provider: 'google',
        timeoutMs: 60000,
      },
    },
  })
  const writing = resolveTaskConfig(config, 'writing')
  assert.equal(writing.model, 'glm-5.3')
  assert.equal(writing.baseUrl, 'http://127.0.0.1:7863/v1')
  assert.equal(writing.apiKeyEnv, 'WEAVE_API_KEY')
  assert.equal(writing.provider, undefined)
  assert.equal(writing.timeoutMs, 180000)

  const extraction = resolveTaskConfig(config, 'extraction')
  assert.equal(extraction.model, 'gemini-2.5-flash')
  assert.equal(extraction.apiKeyEnv, 'Google_API_KEY')
  assert.equal(extraction.provider, 'google')
  assert.equal(extraction.timeoutMs, 60000)
  assert.equal(
    resolveEndpoint(extraction),
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  )
})
