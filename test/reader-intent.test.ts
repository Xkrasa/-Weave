import test from 'node:test'
import assert from 'node:assert/strict'
import { contractHash, normalizeContract } from '../src/core/contract.ts'
import { assembleContext } from '../src/core/context.ts'
import type { ModelConfig } from '../src/core/types.ts'

const base = {
  chapter: 1,
  title: '退单',
  pov: '许舟',
  time: '23:50',
  location: '唐姨家门口',
  openingState: '许舟送出药品',
  endingState: '罚单被撤销',
  goal: '证明按时送达',
  obstacle: '平台时间线异常',
  mustHappen: ['许舟核对退款操作'],
  mayHappen: [],
  mustNotHappen: [],
  characters: ['许舟'],
  threads: ['异常退款'],
  targetWords: 1800,
  previousLink: '开篇',
  nextLink: '追查其他退单',
}

const readerIntent = {
  purpose: 'release',
  payoff: '读者看到许舟用新证据撤销罚单',
  intensity: 'strong',
  hook: '另外六笔异常退款属于谁',
}

const config: ModelConfig = {
  model: 'fake',
  baseUrl: 'http://127.0.0.1:1/v1',
  contextWindow: 8000,
  maxOutputTokens: 1000,
  safetyMarginTokens: 512,
  charsPerToken: 1.6,
  temperature: 0.7,
  timeoutMs: 1000,
  snapshotEvery: 1,
  promptRenderer: 'mission',
}

test('readerIntent is optional, versioned and rendered identically by JSON and mission', () => {
  const legacy = normalizeContract(base)
  assert.equal('readerIntent' in legacy, false)
  assert.equal(contractHash(legacy), contractHash(normalizeContract(base)))

  const intended = normalizeContract({ ...base, readerIntent })
  assert.deepEqual(intended.readerIntent, readerIntent)
  assert.notEqual(contractHash(intended), contractHash(legacy))
  assert.throws(() => normalizeContract({ ...base, readerIntent: { ...readerIntent, payoff: '' } }), /payoff/)
  assert.throws(() => normalizeContract({ ...base, readerIntent: { ...readerIntent, intensity: 'maximum' } }), /intensity/)

  for (const renderer of ['mission', 'json'] as const) {
    const assembled = assembleContext(intended, [], { ...config, promptRenderer: renderer })
    assert.equal(assembled.decision.decision, 'ready')
    const user = assembled.context!.user
    assert.ok(user.includes('release'), renderer)
    assert.ok(user.includes('读者看到许舟用新证据撤销罚单'), renderer)
    assert.ok(user.includes('strong'), renderer)
    assert.ok(user.includes('另外六笔异常退款属于谁'), renderer)
  }
})
