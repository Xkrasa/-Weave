const STATUS_LABELS = { inbox: '收件箱', promoted: '已晋升', archived: '已归档' };
const SCOPE_LABELS = { book: '全书', world: '世界观', mechanic: '机制' };

function scopeLabel(scope) {
  if (!scope) return '全书';
  if (scope.kind === 'chapter') return `第 ${scope.ref} 章`;
  if (scope.kind === 'volume') return `第 ${scope.ref} 卷`;
  if (scope.kind === 'character') return `人物：${scope.ref}`;
  return SCOPE_LABELS[scope.kind] || scope.kind;
}

function badges(idea, escapeHtml) {
  const parts = [`<span class="idea-badge scope">${escapeHtml(scopeLabel(idea.scope))}</span>`];
  if (idea.priority === 'high') parts.push('<span class="idea-badge high">高优先</span>');
  if (idea.priority === 'low') parts.push('<span class="idea-badge low">低优先</span>');
  if (idea.spoilerLevel === 'reveal') {
    parts.push(`<span class="idea-badge spoiler">剧透 ${idea.revealAfterChapter ? `第 ${idea.revealAfterChapter} 章后` : ''}</span>`);
  } else if (idea.spoilerLevel === 'hint') {
    parts.push('<span class="idea-badge spoiler">提示</span>');
  }
  if (idea.promotionState === 'active') parts.push('<span class="idea-badge ok">晋升有效</span>');
  if (idea.promotionState === 'stale') parts.push('<span class="idea-badge warn">晋升已失效</span>');
  if (idea.usage) parts.push('<span class="idea-badge ok">作者标记已用</span>');
  return parts.join('');
}

function jumpTarget(idea) {
  if (idea.scope?.kind === 'chapter') return idea.scope.ref;
  if (Array.isArray(idea.links?.chapters) && idea.links.chapters.length > 0) return idea.links.chapters[0];
  return null;
}

export function renderIdeaPanel(ideas, map, { escapeHtml }) {
  const groups = ['inbox', 'promoted', 'archived'];
  const totals = map?.totals || { inbox: 0, promoted: 0, archived: 0, stale: 0 };
  const list = groups.map(status => {
    const items = ideas.filter(idea => idea.status === status);
    return `
      <div class="idea-group">
        <div class="section-label">${STATUS_LABELS[status]} (${items.length})</div>
        ${items.length === 0
          ? '<div class="empty">没有想法。</div>'
          : items.map(idea => renderIdeaItem(idea, escapeHtml)).join('')}
      </div>`;
  }).join('');
  return `
    <div class="idea-capture">
      <textarea id="idea-capture" rows="3" placeholder="记下一条想法，回车保存（Shift+回车换行）"></textarea>
      <div class="idea-capture-foot">
        <span class="muted small" id="idea-capture-hint">回车保存（Shift+回车换行）· 5 秒内可撤销</span>
        <button class="accent" id="idea-save">保存</button>
      </div>
    </div>
    <div class="idea-summary muted small">收件箱 ${totals.inbox} · 已晋升 ${totals.promoted} · 已归档 ${totals.archived} · 失效 ${totals.stale}</div>
    ${list}`;
}

function renderIdeaItem(idea, escapeHtml) {
  const jump = jumpTarget(idea);
  const actions = [];
  if (idea.status !== 'archived') {
    if (idea.status !== 'promoted') actions.push(`<button data-idea-promote="${escapeHtml(idea.id)}">晋升</button>`);
    actions.push(`<button data-idea-archive="${escapeHtml(idea.id)}">归档</button>`);
  }
  actions.push(idea.usage
    ? `<button data-idea-unused="${escapeHtml(idea.id)}">取消已用标记</button>`
    : `<button data-idea-used="${escapeHtml(idea.id)}">标记已用</button>`);
  if (jump) actions.push(`<button data-idea-jump="${jump}">跳到第 ${jump} 章</button>`);
  return `
    <div class="idea-item ${escapeHtml(idea.status)}">
      <div class="idea-head">
        <strong>${escapeHtml(idea.title)}</strong>
        <span class="muted small">${escapeHtml(idea.id)}</span>
      </div>
      <div class="idea-badges">${badges(idea, escapeHtml)}</div>
      <div class="finding-actions">${actions.join('')}</div>
    </div>`;
}

export function renderIdeaMap(map, { escapeHtml }) {
  const volumes = map.byVolume;
  const bars = volumes.map(bucket => {
    const total = bucket.promoted + bucket.stale;
    const usedWidth = total === 0 ? 0 : Math.round((bucket.used / total) * 100);
    const staleWidth = total === 0 ? 0 : Math.round((bucket.stale / total) * 100);
    return `
      <div class="map-volume">
        <div class="map-volume-head">
          <strong>${bucket.volume === 0 ? '未分卷' : `第 ${bucket.volume} 卷`}</strong>
          <span class="muted small">已晋升 ${bucket.promoted} · 已用 ${bucket.used} · 未用 ${bucket.unused} · 过期 ${bucket.stale}</span>
        </div>
        <div class="map-bar"><i class="used" style="width:${usedWidth}%"></i><i class="stale" style="width:${staleWidth}%"></i></div>
        ${bucket.highPriorityUnused.length
          ? `<div class="map-priority"><span class="idea-badge high">高优先未用</span>${bucket.highPriorityUnused
            .map(item => `<button data-idea-detail="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button>`).join('')}</div>`
          : '<div class="muted small">没有高优先未使用的想法。</div>'}
      </div>`;
  }).join('');

  return `
    <div class="section-label">总计</div>
    <div class="idea-summary">收件箱 ${map.totals.inbox} · 已晋升 ${map.totals.promoted} · 已归档 ${map.totals.archived} · 失效 ${map.totals.stale}</div>
    <div class="section-label">按卷覆盖率</div>
    ${volumes.length ? bars : '<div class="empty">还没有可统计的想法或卷信息。</div>'}
    <div class="section-label">按人物</div>
    ${map.byCharacter.length
      ? map.byCharacter.map(group => `<div class="card"><h3>${escapeHtml(group.name)}</h3><p>${group.ideaIds
        .map(id => `<button data-idea-detail="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join(' ')}</p></div>`).join('')
      : '<div class="empty">没有人物作用域的想法。</div>'}
    <div class="section-label">按标签</div>
    ${map.byTag.length
      ? map.byTag.map(group => `<div class="card"><h3>#${escapeHtml(group.tag)}</h3><p>${group.ideaIds
        .map(id => `<button data-idea-detail="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join(' ')}</p></div>`).join('')
      : '<div class="empty">没有标签。</div>'}
    <p class="muted small">“已用”只统计明确链接到定稿章节、晋升到已定稿合同，或作者手动标记；无法判定时归入“未用”。</p>`;
}

export function renderIdeaDetail(result, { escapeHtml }) {
  const idea = result.meta;
  const lines = [
    `${scopeLabel(idea.scope)} · ${idea.priority === 'high' ? '高优先' : idea.priority === 'low' ? '低优先' : '常规'}`,
    idea.tags.length ? `标签：${idea.tags.map(tag => `#${tag}`).join(' ')}` : '标签：无',
    idea.promotion ? `晋升：${idea.promotion.target} → ${idea.promotion.targetPath}（${idea.promotionState}）` : '尚未晋升',
    idea.usage ? `作者标记已用：${idea.usage.chapters.length ? idea.usage.chapters.map(chapter => `第 ${chapter} 章`).join('、') : '未指定章节'}` : '未被标记已用',
  ];
  return `
    <div class="muted small">${lines.map(line => escapeHtml(line)).join('<br>')}</div>
    <pre class="idea-body">${escapeHtml(result.body)}</pre>`;
}

export function renderPromotionProposal(proposal, { escapeHtml }) {
  const warnings = proposal.warnings.length
    ? `<div class="idea-warnings">${proposal.warnings.map(warning => `<p>${escapeHtml(warning)}</p>`).join('')}</div>`
    : '';
  const diff = proposal.diff.split('\n').map(line => {
    const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  }).join('\n');
  return `
    <div class="section-label">目标：${escapeHtml(proposal.targetPath)}（${escapeHtml(proposal.target)}）</div>
    ${warnings}
    <pre class="idea-diff">${diff}</pre>
    <p class="muted small">尚未写入目标；点“应用”后也只写候选文件，正式批准仍走现有流程。</p>`;
}
