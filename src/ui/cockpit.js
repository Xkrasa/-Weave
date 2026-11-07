// Chapter cockpit renderers. These return HTML strings; app.js owns DOM events.
// All dynamic text must pass through the injected escapeHtml.

const SEVERITY_LABEL = { blocking: '阻断', warning: '警告', info: '提示' }
const SEVERITY_ICON = { blocking: '■', warning: '▲', info: '·' }
const GATE_STATUS_LABEL = { passed: '通过', blocked: '阻塞', stale: '过期', running: '进行中', pending: '未开始' }
const GATE_STATUS_ICON = { passed: '✓', blocked: '✕', stale: '⟳', running: '…', pending: '○' }

function formatTokens(value) {
  const number = Number(value) || 0
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number % 1_000_000 === 0 ? 0 : 1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(number % 1_000 === 0 ? 0 : 1)}k`
  return String(number)
}

export function gateChips(payload) {
  const gates = payload?.gates?.gates ?? []
  const gate = id => gates.find(item => item.id === id)
  const draftHash = payload?.draft?.contentHash
  const stageStatus = id => {
    const summary = payload?.stages?.[summaryKey(id)]
    if (!summary) return 'pending'
    if (summary.draftHash !== draftHash) return 'stale'
    return gate(id)?.ok ? 'passed' : 'blocked'
  }
  const contractGate = gate('contract-check')
  let contractStatus = 'pending'
  if (payload?.contract?.data) {
    const check = payload.contract.check
    if (!check) contractStatus = 'blocked'
    else if (check.contractHash !== payload.contract.hash) contractStatus = 'stale'
    else contractStatus = contractGate?.ok ? 'passed' : 'blocked'
  }
  return [
    { id: 'contract-check', label: '合同检查', status: contractStatus, detail: contractGate?.detail ?? '' },
    { id: 'content-check', label: '内容检查', status: stageStatus('content-check'), detail: gate('content-check')?.detail ?? '' },
    { id: 'extraction', label: '提取', status: stageStatus('extraction'), detail: gate('extraction')?.detail ?? '' },
    { id: 'audit', label: '审计', status: stageStatus('audit'), detail: gate('audit')?.detail ?? '' },
    { id: 'review', label: '审查', status: stageStatus('review'), detail: gate('review')?.detail ?? '' },
    {
      id: 'final',
      label: '定稿',
      status: payload?.finalized ? 'passed' : 'pending',
      detail: payload?.finalized ? `r${payload.revision}` : '未定稿',
    },
  ]
}

function summaryKey(id) {
  if (id === 'content-check') return 'contentCheck'
  return id
}

export function renderGateBar(payload, escapeHtml) {
  const esc = escapeHtml
  return gateChips(payload).map(chip => `
    <span class="gate-chip status-${chip.status}" title="${esc(chip.detail)}">
      <i class="gate-icon">${GATE_STATUS_ICON[chip.status] ?? '○'}</i>
      <span>${esc(chip.label)}</span>
      <span class="gate-state">${GATE_STATUS_LABEL[chip.status] ?? chip.status}</span>
    </span>`).join('')
}

export function renderTopBadges(payload, escapeHtml) {
  const esc = escapeHtml
  const context = payload?.context ?? {}
  const capacity = Number(context.capacityTokens) || 0
  const used = Number(context.usedTokens) || 0
  const percent = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0
  const run = payload?.run
  const runLabel = run
    ? `${run.status === 'running' ? '生成中' : run.status === 'completed' ? '已生成' : run.status === 'failed' ? '生成失败' : '已取消'}${run.draftingStrategy === 'segmented' ? ' · 分段' : ''}`
    : '未生成'
  const runClass = run ? `status-${run.status}` : 'status-pending'
  return `
    <span class="top-badge" id="model-badge">${esc(context.model || '未配置模型')}</span>
    <span class="top-badge" id="window-badge">窗口 ${formatTokens(context.effectiveWindow)} · 预算 ${formatTokens(capacity)}</span>
    <span class="budget-meter" id="budget-meter" title="输入预算 ${used}/${capacity} tokens">
      <span class="budget-bar"><i style="width:${percent}%"></i></span>
      <span class="muted small">${percent}%</span>
    </span>
    <span class="top-badge run ${runClass}" id="run-badge">${esc(runLabel)}</span>`
}

export function statusMetrics(payload, text) {
  const chars = [...String(text ?? '').replace(/\s/g, '')].length
  const charsPerToken = Number(payload?.context?.charsPerToken) || 1.6
  return {
    chars,
    tokens: Math.ceil(chars / charsPerToken),
    blocking: (payload?.findings ?? []).filter(finding =>
      finding.severity === 'blocking' && !['waived', 'ignored'].includes(finding.status)).length,
    used: Number(payload?.context?.usedTokens) || 0,
    capacity: Number(payload?.context?.capacityTokens) || 0,
  }
}

export function renderStatusBar(payload, text, escapeHtml) {
  const esc = escapeHtml
  const metrics = statusMetrics(payload, text)
  const saved = payload?.draft?.meta?.createdAt
    ? new Date(payload.draft.meta.createdAt).toLocaleString('zh-CN', { hour12: false })
    : '未保存'
  const usage = metrics.capacity > 0
    ? `${formatTokens(metrics.used)}/${formatTokens(metrics.capacity)}`
    : '—'
  return `
    <span id="word-count">${metrics.chars} 字</span>
    <span id="token-estimate" class="muted">≈ ${metrics.tokens} tokens</span>
    <span id="save-time" class="muted">保存 ${esc(saved)}</span>
    <span id="blocking-count" class="${metrics.blocking > 0 ? 'text-danger' : 'muted'}">阻断 ${metrics.blocking}</span>
    <span id="context-usage" class="muted">上下文 ${esc(usage)}</span>
    <span id="draft-hash" class="muted">${esc((payload?.draft?.contentHash ?? '').slice(0, 14))}</span>`
}

export function renderIntentStrip(payload, escapeHtml) {
  const esc = escapeHtml
  const contract = payload?.contract?.data
  if (!contract) {
    return `<span class="muted">本章还没有合同。请用 CLI 或“编辑合同”创建后再开始。</span>
      <button id="btn-contract" class="ghost">编辑合同</button>`
  }
  const beats = payload?.beats?.candidate?.beats ?? []
  const turn = beats.find(beat => beat.turn)?.turn ?? '—'
  const intent = contract.readerIntent
  const mustNot = contract.mustNotHappen ?? []
  return `
    <span class="intent-item intent-primary"><b>目标</b>${esc(contract.goal)}</span>
    <span class="intent-item"><b>障碍</b>${esc(contract.obstacle || '—')}</span>
    <span class="intent-item"><b>转折</b>${esc(turn)}</span>
    <span class="intent-item"><b>结尾</b>${esc(contract.endingState)}</span>
    ${intent ? `<span class="intent-item intent-reader"><b>读者</b>目的 ${esc(intent.purpose)} · 回报 ${esc(intent.payoff)}${intent.hook ? ` · 钩子 ${esc(intent.hook)}` : ''}</span>` : ''}
    ${mustNot.length ? `<span class="intent-item intent-danger"><b>禁止</b>${esc(mustNot.join('；'))}</span>` : ''}
    <button id="intent-toggle" class="ghost small">收起</button>
    <button id="btn-contract" class="ghost">编辑合同</button>`
}

function evidenceLocation(finding) {
  if (!finding) return ''
  if (finding.matched === false) return '定位失效：正文已改动'
  const parts = []
  if (finding.line) parts.push(`第 ${finding.line} 行`)
  if (finding.occurrence) parts.push(`第 ${finding.occurrence} 次出现`)
  return parts.join(' · ')
}

function sourceLabel(source) {
  return source === 'content-check' ? '内容检查' : '审查'
}

export function renderFindings(payload, { escapeHtml, activeId } = {}) {
  const esc = escapeHtml
  const findings = payload?.findings ?? []
  if (findings.length === 0) {
    return `<div class="empty">${payload?.stages?.review ? '审查通过，没有 finding。' : '尚未运行审查。'}</div>`
  }
  const truncated = payload?.truncated
    ? '<div class="notice">意见过多，仅显示前 200 条；请用筛选或 CLI 查看全部。</div>'
    : ''
  return truncated + findings.map(finding => {
    const id = `finding:${finding.findingId}`
    const active = id === activeId ? ' active' : ''
    const severity = finding.severity || 'info'
    const hasLocation = finding.matched !== false && finding.charStart != null
    const ignored = finding.status === 'ignored'
    return `
      <div class="finding ${severity}${active}${ignored ? ' ignored' : ''}" data-finding-id="${esc(finding.findingId)}">
        <div class="finding-head">
          <span><i class="sev-icon ${severity}">${SEVERITY_ICON[severity] ?? '·'}</i>${esc(finding.dimension)} · ${SEVERITY_LABEL[severity] ?? esc(severity)}</span>
          <span>${esc(finding.status)}</span>
        </div>
        <p>${esc(finding.description)}</p>
        ${finding.quote ? `<div class="quote">“${esc(finding.quote)}”</div>` : ''}
        <div class="finding-meta">
          <span class="small ${finding.matched === false ? 'text-danger' : 'muted'}">${esc(evidenceLocation(finding))}</span>
          <span class="small muted">${esc(sourceLabel(finding.source))}</span>
        </div>
        ${finding.waiveReason ? `<p class="small muted">豁免：${esc(finding.waiveReason)}</p>` : ''}
        <div class="finding-actions">
          ${hasLocation ? `<button data-focus-finding="${esc(finding.findingId)}">定位</button>` : ''}
          <button data-show-evidence="${esc(id)}">证据</button>
          ${severity === 'warning' && finding.status !== 'waived' ? `<button data-waive="${esc(finding.findingId)}">豁免</button>` : ''}
          ${severity === 'blocking' && ['open', 'planned'].includes(finding.status) ? `<button data-revise="${esc(finding.findingId)}">发起修订</button>` : ''}
          ${severity !== 'blocking' ? `<button data-ignore="${esc(finding.findingId)}">忽略</button>` : ''}
        </div>
      </div>`
  }).join('')
}

export function renderEvidence(payload, { escapeHtml, activeId } = {}) {
  const esc = escapeHtml
  if (activeId) {
    if (activeId.startsWith('finding:')) {
      const finding = (payload?.findings ?? []).find(item => `finding:${item.findingId}` === activeId)
      if (finding) {
        const severity = finding.severity || 'info'
        return `
          <div class="section-label">证据 · ${esc(sourceLabel(finding.source))}</div>
          <div class="evidence-card ${severity}">
            <div class="finding-head"><span>${esc(finding.dimension)} · ${SEVERITY_LABEL[severity] ?? esc(severity)}</span><span>${esc(finding.status)}</span></div>
            <p>${esc(finding.description)}</p>
            ${finding.quote ? `<div class="quote">“${esc(finding.quote)}”</div>` : ''}
            <p class="small muted">${esc(evidenceLocation(finding))}</p>
            ${finding.byteStart != null ? `<p class="code small">byte ${finding.byteStart}–${finding.byteEnd} · char ${finding.charStart}–${finding.charEnd}</p>` : ''}
            <div class="finding-actions">
              ${finding.matched !== false && finding.charStart != null ? `<button data-focus-finding="${esc(finding.findingId)}">定位正文</button>` : ''}
              <button data-tab-jump="findings">回到问题</button>
            </div>
          </div>`
      }
    }
    if (activeId.startsWith('revision:')) {
      const revision = (payload?.revisions ?? []).find(item => `revision:${item.revisionId}` === activeId)
      if (revision) {
        return `
          <div class="section-label">证据 · 修订</div>
          <div class="evidence-card info">
            <div class="finding-head"><span>${esc(revision.revisionId)}</span><span>${esc(revision.status)}</span></div>
            ${revision.selection ? `<p class="small muted">${esc(revision.selection.operation)} · 第 ${revision.selection.occurrence} 次出现</p>
              <div class="quote">“${esc(revision.selection.selectedText)}”</div>
              <p class="small muted">候选：${esc(revision.selection.replacement.slice(0, 120))}</p>` : ''}
            <p class="small ${revision.matched === false ? 'text-danger' : 'muted'}">${esc(evidenceLocation(revision))}</p>
            <div class="finding-actions">
              ${revision.matched !== false && revision.charStart != null ? `<button data-focus-highlight="${esc(activeId)}">定位正文</button>` : ''}
              <button data-tab-jump="revisions">回到版本</button>
            </div>
          </div>`
      }
    }
  }

  const items = [
    ...(payload?.findings ?? []).map(finding => ({
      id: `finding:${finding.findingId}`,
      label: finding.dimension,
      severity: finding.severity,
      quote: finding.quote,
      location: evidenceLocation(finding),
      matched: finding.matched !== false,
      start: finding.charStart ?? Number.MAX_SAFE_INTEGER,
      detail: finding.description,
    })),
    ...(payload?.revisions ?? []).map(revision => ({
      id: `revision:${revision.revisionId}`,
      label: `修订 ${revision.status}`,
      severity: 'info',
      quote: revision.selection?.selectedText,
      location: evidenceLocation(revision),
      matched: revision.matched !== false,
      start: revision.charStart ?? Number.MAX_SAFE_INTEGER,
      detail: revision.selection?.replacement?.slice(0, 80) ?? `${revision.paragraphs} 段候选`,
    })),
  ].sort((left, right) => left.start - right.start || left.id.localeCompare(right.id))
  if (items.length === 0) return '<div class="empty">还没有可定位的证据。</div>'
  return '<div class="section-label">全部证据（按正文位置）</div>' + items.map(item => `
    <div class="evidence-card compact ${item.severity}${item.matched ? '' : ' unmatched'}" data-evidence-id="${esc(item.id)}">
      <div class="finding-head"><span>${esc(item.label)}</span><span>${item.matched ? '可定位' : '定位失效'}</span></div>
      ${item.quote ? `<div class="quote">“${esc(item.quote)}”</div>` : ''}
      <p class="small muted">${esc(item.location)}</p>
    </div>`).join('')
}

export function renderRevisions(payload, { escapeHtml, activeId } = {}) {
  const esc = escapeHtml
  const revisions = payload?.revisions ?? []
  if (revisions.length === 0) {
    return '<div class="empty">还没有修订候选。blocking finding 可以在“问题”里发起修订。</div>'
  }
  return revisions.map(revision => `
    <div class="card revision${`revision:${revision.revisionId}` === activeId ? ' active' : ''}" data-evidence-id="${esc(`revision:${revision.revisionId}`)}">
      <div class="finding-head">
        <h3>${esc(revision.revisionId)}</h3>
        <span class="status-tag status-${esc(revision.status)}">${esc(revision.status)}</span>
      </div>
      <p>${esc(revision.createdAt)} · ${revision.paragraphs} 段候选</p>
      ${revision.selection ? `<div class="quote">“${esc(revision.selection.selectedText)}”</div>
        <p class="small muted">${esc(revision.selection.operation)} · 第 ${revision.selection.occurrence} 次出现</p>` : ''}
      <p class="small ${revision.matched === false ? 'text-danger' : 'muted'}">${esc(evidenceLocation(revision))}</p>
      <div class="finding-actions">
        ${revision.matched !== false && revision.charStart != null ? `<button data-focus-highlight="${esc(`revision:${revision.revisionId}`)}">定位</button>` : ''}
        <button data-merge="${esc(revision.revisionId)}">合并</button>
        <button data-diff="${esc(revision.revisionId)}">查看 diff</button>
      </div>
    </div>`).join('')
}

export function renderBeats(payload, escapeHtml) {
  const esc = escapeHtml
  const view = payload?.beats
  const planView = payload?.segmentPlan
  const beats = view?.candidate?.beats ?? []
  const segments = planView?.plan?.segments ?? []
  return `
    <div class="section-label">节拍</div>
    <div class="card">
      <div class="finding-head"><h3>节拍候选</h3><span class="status-tag status-${esc(view?.status ?? 'missing')}">${esc(view?.status ?? 'missing')}</span></div>
      ${beats.length ? beats.map((beat, index) => `
        <div class="beat-row">
          <div class="beat-index">${String(index + 1).padStart(2, '0')}</div>
          <div>
            <p><b>目标</b> ${esc(beat.goal)}</p>
            <p><b>阻力</b> ${esc(beat.obstacle)}</p>
            <p><b>转折</b> ${esc(beat.turn)}</p>
            <p class="muted small">收束：${esc(beat.endingState)}${beat.segmentId ? ` · 分段 ${esc(beat.segmentId)}` : ''}${beat.targetWords ? ` · ${esc(beat.targetWords)} 字` : ''}</p>
          </div>
        </div>`).join('') : '<div class="empty">还没有节拍候选。</div>'}
    </div>
    <div class="section-label">分段计划</div>
    <div class="card">
      <div class="finding-head"><h3>分段</h3><span class="status-tag status-${esc(planView?.status ?? 'missing')}">${esc(planView?.status ?? 'missing')}</span></div>
      ${segments.length ? segments.map(segment => `
        <div class="beat-row">
          <div class="beat-index">${esc(segment.segmentId)}</div>
          <div>
            <p><b>目标</b> ${esc(segment.goal)}</p>
            <p class="muted small">${esc(segment.entryState)} → ${esc(segment.exitState)}</p>
            <p class="small">${esc(segment.targetWords)} 字 · ${esc(segment.status)}${segment.beatIds?.length ? ` · 节拍 ${esc(segment.beatIds.join('、'))}` : ''}</p>
          </div>
        </div>`).join('') : '<div class="empty">还没有分段计划。</div>'}
    </div>`
}

export function renderContext(payload, escapeHtml) {
  const esc = escapeHtml
  const context = payload?.context ?? {}
  const capacity = Number(context.capacityTokens) || 0
  const used = Number(context.usedTokens) || 0
  const remaining = Number(context.remainingTokens) || Math.max(0, capacity - used)
  const percent = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0
  const list = (title, items) => items?.length
    ? `<div class="section-label">${esc(title)}</div>${items.map(item => `<div class="card compact"><p>${esc(item.sourceId)}</p><p class="small muted">${esc(item.reason)}</p></div>`).join('')}`
    : ''
  const included = Array.isArray(context.included) && context.included.length
    ? `<div class="section-label">已纳入（${context.included.length}）</div>${context.included.map(item => `<div class="card compact">
        <p>${esc(item.sourceId)}${item.required ? ' <span class="status-tag status-pending">必需</span>' : ''}</p>
        <p class="small muted">${esc(item.purpose || item.label || '')} · ${esc(item.category ?? '')} · ${Number(item.tokens) || 0} tokens</p>
      </div>`).join('')}`
    : ''
  return `
    <div class="section-label">上下文预算</div>
    <div class="card">
      <p><b>${esc(context.model || '未配置模型')}</b> · chars/token ${esc(context.charsPerToken ?? '—')}</p>
      <p>有效窗口 ${formatTokens(context.effectiveWindow)} · 输入预算 ${formatTokens(capacity)} · 剩余 ${formatTokens(remaining)}</p>
      <div class="budget-meter wide"><span class="budget-bar"><i style="width:${percent}%"></i></span><span class="muted small">${used}/${capacity} · ${percent}%</span></div>
      <p class="muted small">1M 窗口是能力上限，不是填充目标；超出预算的材料会被省略或降级。</p>
      ${context.error ? `<p class="text-danger small">${esc(context.error)}</p>` : ''}
    </div>
    ${included}
    ${list('被省略（预算）', context.omitted)}
    ${list('按披露扣留', context.withheld)}
    ${list('已降级（预算）', context.degraded)}`
}

export function renderStages(payload, escapeHtml) {
  const esc = escapeHtml
  const rows = [
    ['内容检查', 'contentCheck'],
    ['证据抽取', 'extraction'],
    ['覆盖审计', 'audit'],
    ['审查', 'review'],
  ]
  return rows.map(([label, key]) => {
    const summary = payload?.stages?.[key]
    return `<div class="card">
      <div class="finding-head"><h3>${esc(label)}</h3><span class="status-tag status-${summary ? (summary.passed ? 'passed' : 'blocked') : 'pending'}">${summary ? (summary.passed ? '通过' : '未通过') : '缺失'}</span></div>
      <p class="code small">draft ${esc((summary?.draftHash ?? '—').slice(0, 16))}</p>
    </div>`
  }).join('')
}
