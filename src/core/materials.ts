import path from 'node:path'
import type { ChapterContract, Material, MaterialCategory, MaterialProvenance } from './types.ts'
import { hashText } from './hash.ts'
import { listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { loadCharacters, loadContract } from './contract.ts'
import { projectPaths } from './project.ts'
import { currentCommit, readMainline } from './ledger.ts'
import { collectLedger, effectiveBeliefs, effectiveFacts } from './story-ledger.ts'
import { loadMethods, methodText, selectMethods } from './methods.ts'
import { loadStyleConstitution, loadAuthorSamples, styleText } from './style.ts'
import { conflictError } from './errors.ts'

interface ReferenceManifestEntry {
  id: string
  path: string
  provenance?: MaterialProvenance
  category?: MaterialCategory
  required?: boolean
}

interface ReferenceManifest {
  references?: ReferenceManifestEntry[]
}

export async function collectMaterials(root: string, contract: ChapterContract): Promise<Material[]> {
  const paths = projectPaths(root)
  const materials: Material[] = []

  for (const [file, label] of [
    ['premise.md', '故事前提'],
    ['world.md', '世界设定'],
    ['style.md', '写作风格'],
    ['prohibitions.md', '禁区与约束'],
  ] as const) {
    const text = await readTextIfExists(path.join(paths.canon, file))
    if (text?.trim()) materials.push(material(`canon:${file}`, 'author', 'author', true, label, text))
  }

  const registry = await loadCharacters(root)
  const relevant = registry.characters
    .filter(character => contract.characters.includes(character.name))
    .map(character => ({
      name: character.name,
      status: character.status,
      introducedIn: character.introducedIn,
      ...(character.deathChapter !== undefined ? { deathChapter: character.deathChapter } : {}),
    }))
  if (relevant.length > 0) {
    materials.push(
      material(
        'canon:characters',
        'author',
        'author',
        true,
        '本章人物状态',
        JSON.stringify({ characters: relevant }, null, 2),
      ),
    )
  }

  const priorChapter = Math.max(0, contract.chapter - 1)
  const ledger = await collectLedger(root, priorChapter)
  const povFacts = effectiveFacts(ledger.facts, priorChapter)
    .filter(fact => fact.subject === contract.pov)
  const povBeliefs = effectiveBeliefs(ledger.beliefs, contract.pov, priorChapter)
  if (povFacts.length > 0 || povBeliefs.length > 0) {
    materials.push(
      material(
        'pov:knowledge',
        'derived-locator',
        'derived',
        true,
        `视角人物当前状态（${contract.pov}）`,
        JSON.stringify({ facts: povFacts, beliefs: povBeliefs }, null, 2),
      ),
    )
  }

  if (contract.chapter > 1) {
    const previousCommit = await currentCommit(root, contract.chapter - 1)
    if (!previousCommit) {
      throw conflictError(`第 ${contract.chapter - 1} 章尚未定稿，不能开始第 ${contract.chapter} 章`)
    }
    const previousContract = await loadContract(root, contract.chapter - 1)
    const safeSummary = {
      chapter: contract.chapter - 1,
      title: previousContract.title,
      pov: contract.pov,
      facts: povFacts,
      beliefs: povBeliefs,
      ...(contract.narrativeMode === 'omniscient'
        ? {
            endingState: previousContract.endingState,
            nextLink: previousContract.nextLink,
            visibleKnowledge: contract.visibleKnowledge,
          }
        : {}),
    }
    materials.push(
      material(
        `pov:previous-summary:${contract.chapter - 1}`,
        'derived-locator',
        'derived',
        true,
        '上一章视角安全摘要（不是原文）',
        JSON.stringify(safeSummary, null, 2),
      ),
    )
  }

  for (const offset of [1, 2]) {
    const upcoming = await loadContract(root, contract.chapter + offset).catch(() => null)
    if (!upcoming) continue
    materials.push(
      material(
        `future-plan:${upcoming.chapter}`,
        'future-plan',
        'author',
        false,
        '后续计划（不是既成事实）',
        JSON.stringify(upcoming, null, 2),
      ),
    )
  }

  const head = await readMainline(root)
  const chapterNumbers = Object.keys(head.selectedCommitByChapter)
    .map(Number)
    .sort((a, b) => a - b)
  if (chapterNumbers.length > 0) {
    const rows: string[] = []
    for (const number of chapterNumbers) {
      const title = await loadContract(root, number)
        .then(item => item.title)
        .catch(() => '')
      rows.push(`${String(number).padStart(3, '0')} ${title}`)
    }
    materials.push(
      material(
        'index:chapters',
        'derived-locator',
        'derived',
        false,
        '已定稿章节索引（仅定位）',
        rows.join('\n'),
      ),
    )
  }

  const styleConfig = await readJsonIfExists<Record<string, unknown>>(path.join(paths.canon, 'style.json'))
  if (styleConfig) {
    const style = await loadStyleConstitution(root)
    materials.push(
      material(
        'style:constitution',
        'author',
        'author',
        true,
        '结构化风格宪法',
        styleText(style),
      ),
    )
  }
  const samples = await loadAuthorSamples(root)
  if (samples.length > 0) {
    materials.push(
      material(
        'style:author-samples',
        'author',
        'author',
        true,
        '作者样本段落（优先级高于通用方法）',
        samples.map(sample => sample.text).join('\n\n---\n\n'),
      ),
    )
  }

  const methodSelection = await selectMethods(root, contract.chapter)
  if (methodSelection.modules.length > 0) {
    const library = await loadMethods(root)
    const selected = library.filter(module => methodSelection.modules.some(item => item.id === module.id))
    materials.push(
      material(
        'methods:selected',
        'derived-locator',
        'derived',
        true,
        '按本章诊断选中的写作方法',
        selected.map(methodText).join('\n\n'),
      ),
    )
  }

  const manifest = await readJsonIfExists<ReferenceManifest>(path.join(paths.references, 'manifest.json'))
  if (manifest?.references?.length) {
    for (const entry of manifest.references) {
      const text = await readTextIfExists(path.join(root, entry.path))
      if (!text?.trim()) continue
      materials.push(
        material(
          entry.id,
          entry.category ?? 'reference',
          entry.provenance ?? 'unknown',
          entry.required ?? false,
          `参考：${entry.id}`,
          text,
        ),
      )
    }
  } else {
    for (const name of await listFiles(paths.references)) {
      if (!name.endsWith('.md')) continue
      const text = await readTextIfExists(path.join(paths.references, name))
      if (!text?.trim()) continue
      materials.push(material(`reference:${name}`, 'reference', 'unknown', false, `参考：${name}`, text))
    }
  }

  return materials
}

function material(
  sourceId: string,
  category: MaterialCategory,
  provenance: MaterialProvenance,
  required: boolean,
  label: string,
  text: string,
): Material {
  return {
    sourceId,
    category,
    provenance,
    required,
    label,
    text,
    contentHash: hashText(text),
    visibility: category === 'reference' ? 'author-only' : 'project',
    purpose: label,
  }
}
