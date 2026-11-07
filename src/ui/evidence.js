// Evidence rendering helpers for the chapter cockpit.
// Pure functions only: callers pass escapeHtml so this module has no app dependencies.

export const SEVERITY_RANK = { blocking: 0, warning: 1, info: 2 }

export function findingHighlightId(finding) {
  return `finding:${finding.findingId}`
}

export function revisionHighlightId(revision) {
  return `revision:${revision.revisionId}`
}

/**
 * Builds one highlight per matched finding/revision. Offsets come from the server
 * (`charStart`/`charEnd` UTF-16 code units) and are never recomputed with indexOf here.
 */
export function buildHighlights(payload, { includeRevisions = true } = {}) {
  const items = []
  for (const finding of payload?.findings ?? []) {
    if (!finding?.matched) continue
    if (finding.status === 'ignored') continue
    const start = Number(finding.charStart)
    const end = Number(finding.charEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    items.push({
      id: findingHighlightId(finding),
      kind: 'finding',
      severity: finding.severity || 'info',
      label: finding.dimension || '意见',
      findingId: finding.findingId,
      start,
      end,
      waived: finding.status === 'waived',
    })
  }
  if (includeRevisions) {
    for (const revision of payload?.revisions ?? []) {
      if (!revision?.matched || revision.status !== 'candidate') continue
      const start = Number(revision.charStart)
      const end = Number(revision.charEnd)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
      items.push({
        id: revisionHighlightId(revision),
        kind: 'revision',
        severity: 'info',
        label: revision.selection?.operation || '修订',
        revisionId: revision.revisionId,
        start,
        end,
        waived: false,
      })
    }
  }
  return items
    .map(item => ({ ...item, start: Math.max(0, item.start), end: Math.max(0, item.end) }))
    .filter(item => item.end > item.start)
    .sort((left, right) =>
      (SEVERITY_RANK[left.severity] ?? 3) - (SEVERITY_RANK[right.severity] ?? 3)
      || left.start - right.start
      || left.id.localeCompare(right.id))
}

function severityClass(severity) {
  return severity === 'blocking' ? 'hl-blocking' : severity === 'warning' ? 'hl-warning' : 'hl-info'
}

/**
 * Renders the read-only draft with inline <mark> elements. Whitespace is preserved by
 * `.draft-text { white-space: pre-wrap }`, matching the textarea's own rendering.
 * Overlapping highlights are split at boundaries; the highest-severity one wins the
 * shared slice so the DOM never nests marks.
 */
export function renderDraftView(text, highlights, escapeHtml) {
  const source = String(text ?? '')
  if (!source) return '<div class="empty">还没有草稿。</div>'
  const length = source.length
  const safe = highlights
    .map(item => ({
      ...item,
      start: Math.max(0, Math.min(length, item.start)),
      end: Math.max(0, Math.min(length, item.end)),
    }))
    .filter(item => item.end > item.start)
  if (safe.length === 0) return `<div class="draft-text">${escapeHtml(source)}</div>`

  const points = new Set([0, length])
  for (const item of safe) {
    points.add(item.start)
    points.add(item.end)
  }
  const ordered = [...points].sort((left, right) => left - right)
  const parts = []
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const from = ordered[index]
    const to = ordered[index + 1]
    if (to <= from) continue
    const covering = safe
      .filter(item => item.start <= from && item.end >= to)
      .sort((left, right) =>
        (SEVERITY_RANK[left.severity] ?? 3) - (SEVERITY_RANK[right.severity] ?? 3)
        || (left.end - left.start) - (right.end - right.start)
        || left.id.localeCompare(right.id))
    const active = covering[0]
    const chunk = escapeHtml(source.slice(from, to))
    if (!active) {
      parts.push(chunk)
      continue
    }
    const classes = ['hl', severityClass(active.severity), active.waived ? 'hl-waived' : ''].filter(Boolean).join(' ')
    parts.push(`<mark class="${classes}" data-highlight-id="${escapeHtml(active.id)}">${chunk}</mark>`)
  }
  return `<div class="draft-text">${parts.join('')}</div>`
}

/** Finds the mark for a highlight id without relying on CSS.escape. */
export function findHighlightElement(container, highlightId) {
  return [...container.querySelectorAll('[data-highlight-id]')]
    .find(node => node.dataset.highlightId === highlightId) ?? null
}

export function scrollToHighlight(container, highlightId) {
  const mark = findHighlightElement(container, highlightId)
  if (mark) mark.scrollIntoView({ block: 'center' })
  return Boolean(mark)
}
