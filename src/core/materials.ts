import path from 'node:path'
import type { ChapterContract, Material, MaterialCategory, MaterialProvenance } from './types.ts'
import { hashText } from './hash.ts'
import { listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { loadCharacters, loadContract } from './contract.ts'
import { projectPaths } from './project.ts'
import { currentCommit, finalPath, readMainline } from './ledger.ts'
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
  const relevant = registry.characters.filter(character => contract.characters.includes(character.name))
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

  if (contract.chapter > 1) {
    const previousCommit = await currentCommit(root, contract.chapter - 1)
    if (!previousCommit) {
      throw conflictError(`第 ${contract.chapter - 1} 章尚未定稿，不能开始第 ${contract.chapter} 章`)
    }
    const previous = await readTextIfExists(finalPath(root, contract.chapter - 1))
    if (!previous?.trim()) {
      throw conflictError(`第 ${contract.chapter - 1} 章正式正文为空`)
    }
    materials.push(
      material(
        `final:${contract.chapter - 1}`,
        'finalized-history',
        'finalized',
        true,
        '上一章结尾',
        previousTail(previous, 2400),
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

function previousTail(text: string, limit: number): string {
  const characters = [...text]
  if (characters.length <= limit) return text
  const sliced = characters.slice(-limit).join('')
  const firstBreak = sliced.indexOf('\n')
  return firstBreak >= 0 && firstBreak < 200 ? sliced.slice(firstBreak + 1) : sliced
}
