import { spawnSync } from 'node:child_process'
import path from 'node:path'

const scenarios = [
  ['secret-before-known', 'P1.7 limited POV'],
  ['false-belief', 'P1.2 exposes state'],
  ['age-conflict', 'P1.7 timeline rejects age conflicts'],
  ['payoff-before-plant', 'P1.3 rejects a payoff before planting'],
  ['impact-no-dependency', 'P1.7 impact with no dependency'],
  ['duplicate-evidence', 'P0.5 duplicate evidence'],
  ['no-event-chapter', 'P1.7 accepts a no-event chapter'],
  ['external-drift', 'external drift in formal prose'],
  ['chinese-short-query', 'P2.2 indexes Chinese chunks'],
  ['v2-compat', 'P1.1 keeps v2 commits readable'],
] as const

const cwd = path.resolve(import.meta.dirname, '..')
const result = spawnSync(process.execPath, ['--test', 'test/cli.test.ts'], {
  cwd,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
})
const output = `${result.stdout}\n${result.stderr}`
const passed = output.split(/\r?\n/).filter(line => line.trim().startsWith('✔'))
let failed = false
for (const [label, test] of scenarios) {
  const ok = passed.some(line => line.includes(test))
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}`)
  if (!ok) failed = true
}
if (result.status !== 0) failed = true
process.exitCode = failed ? 1 : 0
