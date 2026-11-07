import type { EvidenceSpan } from './stage-types.ts'

export interface ProjectConfig {
  schemaVersion: 4
  workflowVersion: 1 | 2
  ledgerVersion: 1
  title: string
  language: string
  targetWords: number
  chapterWords: number
  /** Optional target platform used only to select soft review and method profiles. */
  platform?: 'fanqie' | 'qidian' | 'generic'
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
  snapshotEvery: number
  extractionModel?: string
  reviewModel?: string
  effectReviewModel?: string
  /** How structured materials are rendered for the model. */
  promptRenderer?: 'json' | 'mission'
  /** Optional per-task overrides; see model-policy. */
  taskModels?: Partial<Record<'planning' | 'writing' | 'extraction' | 'trustedReview' | 'effectReview' | 'revision', {
    model?: string
    baseUrl?: string
    temperature?: number
    maxOutputTokens?: number
    contextWindow?: number
  }>>
  /** Transparent retries allowed only before the first streamed delta. */
  maxRetries?: number
  retryBaseMs?: number
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
  birthDate?: string
  role?: string
  traits?: string[]
  voice?: string
  desire?: string
  knows?: KnowledgeFact[]
}

export interface CharacterRegistry {
  characters: CharacterRecord[]
}

export interface ContractKnowledgeUse {
  character: string
  fact: string
}

export interface ChapterReaderIntent {
  /** Primary reader-facing function; project-specific labels are allowed. */
  purpose: string
  /** Concrete experience or answer the reader should receive in this chapter. */
  payoff: string
  intensity?: 'strong' | 'medium' | 'soft'
  /** Specific question or expectation carried into the next chapter. */
  hook?: string
  /** ReaderPromises advanced or related in this chapter. */
  promiseIds?: string[]
  /** ReaderPromises planned to be paid off in this chapter; must be included in promiseIds. */
  payoffPromiseIds?: string[]
}

export interface ChapterContract {
  chapter: number
  /** Optional volume used only for planning-reference validation. */
  volume?: number
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
  narrativeMode?: 'limited' | 'omniscient'
  visibleKnowledge?: string[]
  targetWords: number
  previousLink: string
  nextLink: string
  /** Optional reader-effect goal; versioned with the contract but never a hard prose gate. */
  readerIntent?: ChapterReaderIntent
  /** Scene categories used for scoped review and samples; distinct from readerIntent.purpose. */
  sceneTypes?: string[]
  /** Key chapters may ask for a few paragraph-level candidates. */
  importance?: 'normal' | 'key'
  keyFocus?: string[]
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
  /** Lower runs first when budgets are tight. Defaults to 100. */
  priority?: number
  /** Retrieval relevance; keeps ranking through budget trimming. */
  relevance?: number
  /** 紧凑形态（如「姓名 + 一句话身份」）：预算不足时先降级到它、再丢弃；文案自带「（本章未展开）」标记。 */
  compact?: string
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

export interface LedgerEvent {
  eventId: string
  chapter: number
  summary: string
  storyTime?: string
  storyDay?: number
  storyDate?: string
  participants: string[]
  location?: string
  causedBy: string[]
  evidence: EvidenceSpan[]
}

export type OpenLoopStatus = 'planted' | 'active' | 'advanced' | 'paid_off' | 'abandoned'

export interface LoopChange {
  loopId: string
  kind: 'plant' | 'advance' | 'payoff' | 'abandon'
  chapter: number
  summary: string
  targetFromChapter?: number
  targetToChapter?: number
  relatedEntities: string[]
  reason?: string
  evidence: EvidenceSpan[]
}

export interface OpenLoop {
  loopId: string
  summary: string
  status: OpenLoopStatus
  plantedChapter: number
  lastAdvancedChapter: number
  targetFromChapter?: number
  targetToChapter?: number
  paidOffChapter?: number
  relatedEntities: string[]
  abandonReason?: string
  evidence: EvidenceSpan[]
}

export interface LedgerFact {
  factId: string
  chapter: number
  subject: string
  predicate: string
  object: string
  /** 数值总账（整数最小单位，不用小数）；balance 为 null 表示基线不明、只报变化量。可选字段，旧数据没有。 */
  quantity?: {
    delta: number
    balance: number | null
    unit: string
    unverified?: boolean
  }
  validFromChapter: number
  validToChapter: number | null
  sourceEvent?: string
  origin: 'author' | 'derived' | 'candidate'
  supersedes?: string | null
  confidence: number
  evidence: EvidenceSpan[]
}

/** checkBalances 找到的对不上的账：三值齐全，交作者裁决，不阻断定稿。 */
export interface QuantityBreak {
  subject: string
  predicate: string
  unit: string
  chapter: number
  factId: string
  previousBalance: number | null
  delta: number
  statedBalance: number
  expectedBalance: number
  quote: string
}

export type BeliefAttitude = 'knows' | 'believes' | 'suspects' | 'misbelieves' | 'doubts'

export interface LedgerBelief {
  beliefId: string
  chapter: number
  characterId: string
  proposition: string
  attitude: BeliefAttitude
  sourceEvent?: string
  learnedAtChapter: number
  confidence: number
  validFromChapter: number
  validToChapter: number | null
  evidence: EvidenceSpan[]
}

export interface LedgerContractRef {
  chapter: number
  contractHash: string
  planned: string[]
}

export interface LedgerDelta {
  contract?: LedgerContractRef
  events: LedgerEvent[]
  facts: LedgerFact[]
  beliefs: LedgerBelief[]
  loops?: LoopChange[]
}

export interface CommitRecord {
  schemaVersion: 1 | 2 | 3
  commitId: string
  chapter: number
  revision: number
  supersedes: string | null
  contentHash: string
  contractHash: string
  contextHash: string
  contentPath: string
  createdAt: string
  extractionHash?: string
  reviewHash?: string
  evidenceCount?: number
  ledgerHash?: string
  eventCount?: number
  factCount?: number
  beliefCount?: number
  loopCount?: number
  ledger?: LedgerDelta
  evidence: EvidenceSpan[]
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
  dependencies?: string[]
  evidence?: string[]
  sourceCommit?: string
  status: 'pending' | 'accepted' | 'revision-planned' | 'deferred'
  decidedAt?: string
}

export interface ImpactReport {
  schemaVersion: 1
  sourceChapter: number
  sourceRevision: number
  sourceCommit: string
  mainlineRevision?: number
  createdAt: string
  items: ImpactItem[]
}

export interface RunUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface StreamAttempt {
  attempt: number
  status: 'ok' | 'retry' | 'failed'
  reason?: string
  waitMs?: number
  startedAt: string
}

/** A fresh run that supersedes a failed one; it never concatenates onto the old partial. */
export interface RunRecovery {
  fromRunId: string
  partialPath: string
  strategy: 'regenerate'
}

export interface RunRecord {
  schemaVersion: 1
  runId: string
  chapter: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  task?: 'planning' | 'writing' | 'extraction' | 'trustedReview' | 'effectReview' | 'revision'
  model: string
  baseUrl: string
  startedAt: string
  finishedAt?: string
  contextHash?: string
  promptHash?: string
  materialSourceIds: string[]
  draftingStrategy?: 'prose-first' | 'beat-first'
  beatContentHash?: string
  sampleSelection?: {
    samples: Array<{ id: string }>
    selected: Array<{ id: string; score: number; reasons: string[] }>
    reasons: string[]
    estimatedTokens: number
    fallback: boolean
  }
  methodSelection?: {
    modules: Array<{ id: string; version: number; reason: string }>
    reasons: string[]
    estimatedTokens: number
  }
  partialPath?: string
  error?: string
  usage?: RunUsage
  attempts?: StreamAttempt[]
  recovery?: RunRecovery
}

export interface ProjectionState {
  name: string
  mainlineRevision: number
  appliedThrough: number
  lastCommit: string | null
  invalidFrom: number | null
  replayBaseChapter: number | null
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
