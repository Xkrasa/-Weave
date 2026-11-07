import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleContext } from '../src/core/context.ts'
import { normalizeContract } from '../src/core/contract.ts'
import { hashText } from '../src/core/hash.ts'
import type { Material, ModelConfig } from '../src/core/types.ts'

const contract = normalizeContract({
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
})

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

function material(overrides: Partial<Material> & { sourceId: string; text: string }): Material {
  return {
    category: 'reference',
    provenance: 'generated',
    required: false,
    label: overrides.sourceId,
    contentHash: hashText(overrides.text),
    visibility: 'project',
    purpose: 'test',
    ...overrides,
  }
}

test('ready report carries the withheld/degraded classification even when empty', () => {
  const assembled = assembleContext(contract, [
    material({ sourceId: 'canon:premise.md', text: '前提一句话。', required: true, provenance: 'author', category: 'author' }),
  ], config)
  assert.equal(assembled.decision.decision, 'ready')
  const report = assembled.context
  assert.ok(report)
  assert.deepEqual(report.omitted, [])
  assert.deepEqual(report.withheld, [])
  assert.deepEqual(report.degraded, [])
  assert.equal(report.included.length, 1)
})

test('budget omission stays in omitted and never masquerades as withheld or degraded', () => {
  const assembled = assembleContext(contract, [
    material({ sourceId: 'canon:premise.md', text: '前提一句话。', required: true, provenance: 'author', category: 'author' }),
    material({ sourceId: 'search:old-scene', text: '很长的旧场景证据。'.repeat(2000) }),
  ], config)
  assert.equal(assembled.decision.decision, 'ready')
  const report = assembled.context
  assert.ok(report)
  assert.deepEqual(report.omitted, [{ sourceId: 'search:old-scene', reason: 'budget' }])
  assert.deepEqual(report.withheld, [])
  assert.deepEqual(report.degraded, [])
})

test('unknown provenance is omitted when optional and still blocks when required', () => {
  const optionalUnknown = assembleContext(contract, [
    material({ sourceId: 'canon:premise.md', text: '前提一句话。', required: true, provenance: 'author', category: 'author' }),
    material({ sourceId: 'pasted:dubious', text: '来源不明的粘贴材料。', provenance: 'unknown' }),
  ], config)
  assert.equal(optionalUnknown.decision.decision, 'ready')
  assert.deepEqual(optionalUnknown.context!.omitted, [{ sourceId: 'pasted:dubious', reason: 'unknown-provenance' }])

  const requiredUnknown = assembleContext(contract, [
    material({ sourceId: 'pasted:dubious', text: '来源不明的粘贴材料。', provenance: 'unknown', required: true }),
  ], config)
  assert.equal(requiredUnknown.decision.decision, 'capacity-conflict')
  assert.equal(requiredUnknown.context, null)
})

test('required overflow keeps the explicit split-required failure semantics', () => {
  const assembled = assembleContext(contract, [
    material({ sourceId: 'canon:world-a.md', text: '设定甲。'.repeat(2000), required: true, provenance: 'author', category: 'author' }),
    material({ sourceId: 'canon:world-b.md', text: '设定乙。'.repeat(2000), required: true, provenance: 'author', category: 'author' }),
  ], config)
  assert.equal(assembled.decision.decision, 'split-required')
  assert.equal(assembled.context, null)
})
