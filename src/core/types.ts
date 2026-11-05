export interface ProjectConfig {
  schemaVersion: 1
  title: string
  language: string
  targetWords: number
  chapterWords: number
  createdAt: string
}

export interface ModelConfig {
  model: string
  baseUrl: string
  contextWindow: number
  maxOutputTokens: number
  safetyMarginTokens: number
  charsPerToken: number
  temperature: number
  timeoutMs: number
}

export interface KnowledgeFact {
  fact: string
  fromChapter: number
}

export interface CharacterRecord {
  name: string
  status: 'alive' | 'dead'
  introducedIn: number
  deathChapter?: number
  knows?: KnowledgeFact[]
}

export interface CharacterRegistry {
  characters: CharacterRecord[]
}

export interface ContractKnowledgeUse {
  character: string
  fact: string
}

export interface ChapterContract {
  chapter: number
  title: string
  pov: string
  time: string
  location: string
  openingState: string
  endingState: string
  goal: string
  obstacle?: string
  mustHappen: string[]
  mayHappen: string[]
  mustNotHappen: string[]
  characters: string[]
  threads: string[]
  knowledge?: ContractKnowledgeUse[]
  targetWords: number
  previousLink: string
  nextLink: string
}

export type MaterialCategory =
  | 'author'
  | 'finalized-history'
  | 'future-plan'
  | 'derived-locator'
  | 'reference'

export type MaterialProvenance =
  | 'author'
  | 'finalized'
  | 'generated'
  | 'derived'
  | 'legacy'
  | 'unknown'

export interface Material {
  sourceId: string
  category: MaterialCategory
  provenance: MaterialProvenance
  required: boolean
  label: string
  text: string
  contentHash: string
  visibility: 'project' | 'author-only'
  purpose: string
}

export type MaterialDecision =
  | {
      decision: 'ready'
      included: Material[]
      omitted: Array<{ sourceId: string; reason: 'budget' | 'unknown-provenance' }>
      requiredTokens: number
      capacityTokens: number
    }
  | {
      decision: 'split-required'
      blockingSourceId: string
      omissions: Array<{ sourceId: string; reason: 'budget' | 'unknown-provenance' }>
      requiredTokens: number
      capacityTokens: number
      message: string
    }
  | {
      decision: 'capacity-conflict'
      blockingSourceId: string
      omissions: Array<{ sourceId: string; reason: 'budget' | 'unknown-provenance' }>
      requiredTokens: number
      capacityTokens: number
      message: string
    }

export interface GenerationEvent {
  type: 'started' | 'delta' | 'usage' | 'completed' | 'failed' | 'cancelled'
  seq: number
  runId: string
  chapter: number
  text?: string
  usage?: RunUsage
  draft?: string
  error?: string
}

export interface CommitRecord {
  schemaVersion: 1
  commitId: string
  chapter: number
  revision: number
  supersedes: string | null
  contentHash: string
  contractHash: string
  contextHash: string
  contentPath: string
  createdAt: string
  evidence: never[]
}

export interface MainlineHead {
  mainlineRevision: number
  selectedCommitByChapter: Record<string, string>
  previousHead: string | null
  updatedAt: string
}

export interface ImpactItem {
  targetChapter: number
  level: 'confirmed' | 'likely' | 'unknown'
  reason: string
  status: 'pending' | 'accepted' | 'revision-planned' | 'deferred'
  decidedAt?: string
}

export interface ImpactReport {
  schemaVersion: 1
  sourceChapter: number
  sourceRevision: number
  sourceCommit: string
  createdAt: string
  items: ImpactItem[]
}

export interface RunUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface RunRecord {
  schemaVersion: 1
  runId: string
  chapter: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  model: string
  baseUrl: string
  startedAt: string
  finishedAt?: string
  contextHash?: string
  promptHash?: string
  materialSourceIds: string[]
  partialPath?: string
  error?: string
  usage?: RunUsage
}

export interface ProjectionState {
  name: string
  mainlineRevision: number
  appliedThrough: number
  lastCommit: string | null
  invalidFrom: number | null
  status: 'current' | 'stale' | 'failed'
  updatedAt: string
}

export interface DraftMeta {
  chapter: number
  contentHash: string
  runId: string
  baseCommit: string | null
  createdAt: string
}
