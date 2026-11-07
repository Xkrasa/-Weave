import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHighlights, renderDraftView } from '../src/ui/evidence.js'

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
}

const text = '甲\r\n\r\n乙甲\r\n\r\n甲'
const first = text.indexOf('甲')
const second = text.indexOf('甲', first + 1)
const third = text.indexOf('甲', second + 1)

test('highlights use the server char offsets and skip unmatched/ignored items', () => {
  const payload = {
    findings: [
      { findingId: 'f2', matched: true, charStart: second, charEnd: second + 1, severity: 'blocking', status: 'open', dimension: '重复' },
      { findingId: 'stale', matched: false, charStart: 0, charEnd: 1, severity: 'warning', status: 'open', dimension: '旧引文' },
      { findingId: 'ignored', matched: true, charStart: third, charEnd: third + 1, severity: 'info', status: 'ignored', dimension: '忽略' },
    ],
    revisions: [
      { revisionId: 'rev', matched: true, charStart: first, charEnd: first + 1, status: 'candidate', selection: { operation: 'polish' } },
      { revisionId: 'merged', matched: true, charStart: third, charEnd: third + 1, status: 'merged' },
    ],
  }
  const highlights = buildHighlights(payload)
  assert.equal(highlights.length, 2)
  assert.equal(highlights[0].id, 'finding:f2')
  assert.equal(highlights[0].start, second)
  assert.equal(highlights[1].id, 'revision:rev')
  assert.equal(highlights[1].start, first)
})

test('review markup marks exactly the selected occurrence and preserves whitespace', () => {
  const payload = {
    findings: [{ findingId: 'f2', matched: true, charStart: second, charEnd: second + 1, severity: 'warning', status: 'open', dimension: '重复' }],
    revisions: [],
  }
  const html = renderDraftView(text, buildHighlights(payload), escapeHtml)
  assert.match(html, /<div class="draft-text">/)
  assert.equal((html.match(/<mark/g) || []).length, 1)
  const marked = html.slice(html.indexOf('<mark'), html.indexOf('</mark>') + '</mark>'.length)
  assert.ok(marked.includes('data-highlight-id="finding:f2"'))
  // The first and third occurrences stay outside the mark, and the original blank lines survive.
  assert.ok(html.indexOf('<mark') > html.indexOf('乙甲'))
  assert.match(html, /\r\n\r\n/)
})

test('review markup escapes story text and highlight ids', () => {
  const html = renderDraftView('<script>alert(1)</script>', [
    { id: 'finding:"x"', severity: 'info', start: 0, end: 8 },
  ], escapeHtml)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /data-highlight-id="finding:&quot;x&quot;"/)
})

test('overlapping highlights never nest marks and a blocking range wins the shared slice', () => {
  const html = renderDraftView('abcdef', [
    { id: 'warning', severity: 'warning', start: 1, end: 4 },
    { id: 'blocking', severity: 'blocking', start: 2, end: 5 },
  ], escapeHtml)
  assert.doesNotMatch(html, /<mark[^>]*>[^<]*<mark/)
  assert.match(html, /hl-warning[^>]*>b</)
  assert.match(html, /hl-blocking[^>]*>cd</)
  assert.match(html, /hl-blocking[^>]*>e</)
  assert.match(html, />f</)
})
