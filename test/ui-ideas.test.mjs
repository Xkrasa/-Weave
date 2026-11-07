import test from 'node:test'
import assert from 'node:assert/strict'
import { renderIdeaDetail, renderIdeaMap, renderIdeaPanel, renderPromotionProposal } from '../src/ui/ideas.js'

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
}

const map = {
  totals: { inbox: 1, promoted: 2, archived: 1, stale: 1 },
  byVolume: [
    { volume: 0, promoted: 0, used: 0, unused: 0, stale: 0, highPriorityUnused: [] },
    {
      volume: 1,
      promoted: 1,
      used: 1,
      unused: 0,
      stale: 1,
      highPriorityUnused: [{ id: 'idea-20260101-aaaaaa', title: '未用的高优先想法' }],
    },
  ],
  byCharacter: [{ name: '林岚', ideaIds: ['idea-20260101-aaaaaa'] }],
  byTag: [{ tag: '人物', ideaIds: ['idea-20260101-aaaaaa'] }],
}

const ideas = [
  { id: 'idea-20260101-aaaaaa', title: '收件箱想法', status: 'inbox', priority: 'high', tags: ['人物'], scope: { kind: 'chapter', ref: 3 }, spoilerLevel: 'reveal', revealAfterChapter: 5, promotionState: 'none', links: { chapters: [] } },
  { id: 'idea-20260101-bbbbbb', title: '已晋升想法', status: 'promoted', priority: 'normal', tags: [], scope: { kind: 'volume', ref: 1 }, spoilerLevel: 'none', promotionState: 'active', links: { chapters: [3] } },
  { id: 'idea-20260101-cccccc', title: '已归档想法', status: 'archived', priority: 'low', tags: [], scope: { kind: 'book' }, spoilerLevel: 'none', promotionState: 'none', links: { chapters: [] } },
]

test('the idea panel groups by status, shows totals and keeps capture undo text', () => {
  const html = renderIdeaPanel(ideas, map, { escapeHtml })
  assert.match(html, /收件箱 1 · 已晋升 2 · 已归档 1 · 失效 1/)
  assert.match(html, /收件箱 \(1\)/)
  assert.match(html, /已晋升 \(1\)/)
  assert.match(html, /已归档 \(1\)/)
  assert.match(html, /id="idea-capture"/)
  assert.match(html, /5 秒内可撤销/)
  assert.match(html, /data-idea-promote="idea-20260101-aaaaaa"/)
  assert.match(html, /data-idea-jump="3"/)
  // Archived ideas are not offered a promotion action.
  assert.doesNotMatch(html, /data-idea-promote="idea-20260101-cccccc"/)
})

test('the map is conservative: ambiguous ideas stay unused and high-priority unused is visible', () => {
  const html = renderIdeaMap(map, { escapeHtml })
  assert.match(html, /第 1 卷/)
  assert.match(html, /已晋升 1 · 已用 1 · 未用 0 · 过期 1/)
  assert.match(html, /未用的高优先想法/)
  assert.match(html, /无法判定时归入“未用”/)
  assert.match(html, /data-idea-detail="idea-20260101-aaaaaa"/)
})

test('idea, scope and diff text are escaped', () => {
  const detail = renderIdeaDetail({
    meta: { ...ideas[0], title: '<script>x</script>', scope: { kind: 'character', ref: '"林岚"' } },
    body: '<img src=x onerror=alert(1)>',
  }, { escapeHtml })
  assert.doesNotMatch(detail, /<script>/)
  assert.doesNotMatch(detail, /<img src=x/)
  assert.match(detail, /&lt;img src=x/)

  const proposal = renderPromotionProposal({
    ideaId: 'idea-1',
    target: 'plan',
    targetPath: 'plans/idea-promotions/<x>.md',
    currentHash: 'sha256:x',
    proposedText: '',
    diff: '+新增 <bad>\n-删除',
    warnings: ['<warn>'],
  }, { escapeHtml })
  assert.doesNotMatch(proposal, /<bad>/)
  assert.doesNotMatch(proposal, /<warn>/)
  assert.match(proposal, /class="add"/)
  assert.match(proposal, /class="del"/)
})
