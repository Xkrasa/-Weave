import { buildHighlights, findingHighlightId, renderDraftView, scrollToHighlight } from './evidence.js';
import { renderIdeaDetail, renderIdeaMap, renderIdeaPanel, renderPromotionProposal } from './ideas.js';
import {
  renderBeats,
  renderContext,
  renderEvidence,
  renderFindings,
  renderGateBar,
  renderIntentStrip,
  renderRevisions,
  renderStages,
  renderStatusBar,
  renderTopBadges,
} from './cockpit.js';

const state = {
  token: '',
  status: null,
  chapters: [],
  current: null,
  cockpit: null,
  tab: 'findings',
  dirty: false,
  offsetsStale: false,
  saveTimer: null,
  waivers: [],
  preferences: {},
  writeController: null,
  selectionBusy: false,
  eval: null,
  mode: 'edit',
  filter: 'all',
  activeEvidence: null,
  intentCollapsed: false,
  reviewScrollRatio: 0,
  lastIdeaCapture: null,
  ideasBusy: false,
  pendingProposal: null,
  ideaUndoTimer: null,
  inlineDiff: null,
  compare: null,
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string') {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  if (options.method && options.method !== 'GET') headers['x-weave-token'] = state.token;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error || { message: `HTTP ${response.status}` };
    throw Object.assign(new Error(error.message), { details: error.details, code: error.code });
  }
  return payload;
}

function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.style.borderColor = isError ? '#7b3d34' : '#4a525d';
  node.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add('hidden'), 4200);
}

// ---- Chapter list -----------------------------------------------------------

const STAGE_KEYS = ['contract', 'beats', 'segments', 'draft', 'check', 'final'];
const STAGE_LABELS = ['合同', '节拍', '分段', '草稿', '检查', '定稿'];

function stageDotClass(stages, key, index) {
  if (stages?.[key]) return 'ok';
  const later = STAGE_KEYS.slice(index + 1).some(item => stages?.[item]);
  if (later) return 'blocked';
  const earlier = STAGE_KEYS.slice(0, index).some(item => stages?.[item]);
  return earlier ? 'running' : 'pending';
}

function chapterDots(chapter) {
  return `<span class="stage-dots" aria-label="阶段进度">${STAGE_KEYS.map((key, index) => `
    <i class="stage-dot ${stageDotClass(chapter.stages, key, index)}" title="${escapeHtml(`${STAGE_LABELS[index]}：${stageDotClass(chapter.stages, key, index)}`)}"></i>`).join('')}</span>`;
}

function visibleChapters() {
  return state.chapters.filter(chapter => {
    if (state.filter === 'blocking') return chapter.blocking > 0;
    if (state.filter === 'failed') return chapter.runStatus === 'failed' || chapter.runStatus === 'cancelled';
    if (state.filter === 'recoverable') return chapter.recoverable;
    return true;
  });
}

function renderShell() {
  const status = state.status;
  if (!status) return;
  $('#project-title').textContent = status.title;
  $('#project-subtitle').textContent = `主线 r${status.mainlineRevision} · ${status.chapters.length} 章定稿 · ${status.drafts.length} 草稿`;
  $('#project-flags').textContent = `内容投影 ${status.projection?.status ?? '无'} · 账本投影 ${status.ledgerProjection?.status ?? '无'} · 未处理影响 ${status.pendingImpacts}`;
  const list = visibleChapters();
  $('#chapter-count').textContent = `${list.length}/${state.chapters.length}`;
  $('#chapter-list').innerHTML = list.length
    ? list.map(chapter => `
      <div class="chapter-item ${state.current === chapter.chapter ? 'active' : ''}" data-chapter="${chapter.chapter}">
        <span class="num">${String(chapter.chapter).padStart(3, '0')}</span>
        <span class="chapter-main">
          <span class="name">${escapeHtml(chapter.title || `第 ${chapter.chapter} 章`)}</span>
          ${chapterDots(chapter)}
        </span>
        <span class="chapter-tail">${chapter.blocking
          ? `<span class="badge">${chapter.blocking}</span>`
          : chapter.runStatus === 'running'
            ? '<span class="mini-run">生成中</span>'
            : chapter.recoverable ? '<span class="mini-run">可恢复</span>' : ''}</span>
      </div>`).join('')
    : '<div class="empty">没有符合条件的章节。</div>';
  $$('.chapter-item').forEach(node => node.addEventListener('click', () => openChapter(Number(node.dataset.chapter))));
  $$('#chapter-filters button').forEach(node => node.classList.toggle('active', node.dataset.filter === state.filter));
}

async function refresh() {
  const [status, chapters] = await Promise.all([api('/api/status'), api('/api/chapters')]);
  state.status = status;
  state.chapters = chapters.chapters;
  if (!state.current) {
    const saved = Number(state.preferences.lastChapter);
    state.current = state.chapters.some(item => item.chapter === saved)
      ? saved
      : state.chapters[0]?.chapter ?? null;
  }
  renderShell();
  if (state.current) await openChapter(state.current, true);
}

// ---- Cockpit ---------------------------------------------------------------

function captureScroll() {
  const editor = $('#draft');
  const view = $('#draft-view');
  return {
    editor: editor.scrollTop / Math.max(1, editor.scrollHeight - editor.clientHeight),
    view: view.scrollTop / Math.max(1, view.scrollHeight - view.clientHeight),
  };
}

function currentScrollRatio() {
  const node = state.mode === 'edit' ? $('#draft') : $('#draft-view');
  return node.scrollTop / Math.max(1, node.scrollHeight - node.clientHeight);
}

function restoreScroll(ratios) {
  const editor = $('#draft');
  const view = $('#draft-view');
  editor.scrollTop = ratios.editor * Math.max(1, editor.scrollHeight - editor.clientHeight);
  view.scrollTop = ratios.view * Math.max(1, view.scrollHeight - view.clientHeight);
}

function renderCockpitPanels() {
  const payload = state.cockpit;
  if (!payload) return;
  $('#top-badges').innerHTML = renderTopBadges(payload, escapeHtml);
  $('#intent-strip').innerHTML = renderIntentStrip(payload, escapeHtml);
  $('#intent-strip').classList.toggle('collapsed', state.intentCollapsed);
  $('#gate-bar').innerHTML = renderGateBar(payload, escapeHtml);
  renderNextAction();
  updateStatusBar();
  $('#btn-contract')?.addEventListener('click', showContractEditor);
  $('#intent-toggle')?.addEventListener('click', () => {
    state.intentCollapsed = !state.intentCollapsed;
    $('#intent-strip').classList.toggle('collapsed', state.intentCollapsed);
    const toggle = $('#intent-toggle');
    if (toggle) toggle.textContent = state.intentCollapsed ? '展开' : '收起';
  });
  const toggle = $('#intent-toggle');
  if (toggle) toggle.textContent = state.intentCollapsed ? '展开' : '收起';
}

function renderNextAction() {
  const next = state.cockpit?.nextAction;
  const button = $('#btn-next');
  if (!button) return;
  if (!next) {
    button.disabled = true;
    button.textContent = '下一步';
    return;
  }
  button.disabled = next.kind === 'done';
  button.textContent = next.kind === 'done' ? next.label : `下一步：${next.label}`;
  button.dataset.actionKind = next.kind;
}

function updateStatusBar() {
  if (!state.cockpit) {
    $('#word-count').textContent = `${[...($('#draft').value || '').replace(/\s/g, '')].length} 字`;
    return;
  }
  $('#status-bar').innerHTML = renderStatusBar(state.cockpit, $('#draft').value, escapeHtml);
}

function renderDraftViewMarkup() {
  if (!state.cockpit) return;
  const highlights = buildHighlights(state.cockpit);
  $('#draft-view').innerHTML = renderDraftView(state.cockpit.draft.text, highlights, escapeHtml);
  $$('#draft-view [data-highlight-id]').forEach(node => {
    node.classList.add('clickable');
    node.addEventListener('click', () => showEvidence(node.dataset.highlightId));
  });
}

function applyMode(ratios = captureScroll()) {
  const review = state.mode === 'review';
  $('#draft').classList.toggle('hidden', review);
  $('#draft-view').classList.toggle('hidden', !review);
  $('#btn-mode').textContent = review ? '编辑模式' : '审阅模式';
  if (review) renderDraftViewMarkup();
  requestAnimationFrame(() => restoreScroll(ratios));
}

async function toggleMode() {
  if (!state.current) return;
  if (state.mode === 'edit') {
    if (state.dirty) {
      try {
        await saveDraft();
      } catch {
        return;
      }
    }
    if (state.offsetsStale) await refreshCockpit();
    const ratio = currentScrollRatio();
    state.mode = 'review';
    applyMode({ editor: ratio, view: ratio });
  } else {
    const ratio = currentScrollRatio();
    state.mode = 'edit';
    applyMode({ editor: ratio, view: ratio });
  }
}

async function ensureFreshOffsets() {
  if (state.dirty) await saveDraft();
  if (state.offsetsStale) await refreshCockpit();
}

async function refreshCockpit() {
  if (!state.current) return;
  const ratios = captureScroll();
  state.cockpit = await api(`/api/chapters/${state.current}/cockpit`);
  state.offsetsStale = false;
  renderCockpitPanels();
  if (state.mode === 'review') renderDraftViewMarkup();
  requestAnimationFrame(() => restoreScroll(ratios));
  if (['findings', 'evidence', 'revisions', 'segments', 'beats', 'context', 'stages', 'contract'].includes(state.tab)) {
    await renderInspector();
  }
}

async function openChapter(chapter, silent = false) {
  if (!silent && state.dirty && !confirm('当前草稿还有未保存修改，切换章节会丢失。继续？')) return;
  state.current = chapter;
  state.cockpit = await api(`/api/chapters/${chapter}/cockpit`);
  state.activeEvidence = null;
  state.inlineDiff = null;
  state.compare = null;
  state.mode = 'edit';
  state.offsetsStale = false;
  state.preferences.lastChapter = chapter;
  await persistPreferences();
  const payload = state.cockpit;
  const contract = payload.contract.data;
  $('#chapter-eyebrow').textContent = `第 ${chapter} 章 · ${payload.stages.review?.passed ? '审查通过' : payload.stages.review ? '存在意见' : '未审查'}${payload.finalized ? ` · r${payload.revision}` : ''}`;
  $('#chapter-title').textContent = contract?.title || `第 ${chapter} 章`;
  $('#draft').value = payload.draft.text;
  clearTimeout(state.saveTimer);
  state.dirty = false;
  state.saveTimer = null;
  updateSave('已保存');
  updateSelectionTools();
  renderCockpitPanels();
  applyMode({ editor: 0, view: 0 });
  renderShell();
  await Promise.all([renderInspector(), loadWaivers()]);
}

function showContractEditor() {
  const contract = state.cockpit?.contract?.data;
  if (!contract) return;
  showModal('编辑合同', `<textarea id="contract-json" spellcheck="false">${escapeHtml(JSON.stringify(contract, null, 2))}</textarea>`, [
    { label: '取消', action: closeModal },
    {
      label: '保存',
      action: async () => {
        try {
          const next = JSON.parse($('#contract-json').value);
          await api(`/api/chapters/${state.current}/contract`, { method: 'PUT', body: next });
          closeModal();
          await refreshCockpit();
          toast('合同已保存；请重新运行合同检查');
        } catch (error) {
          toast(error.message, true);
        }
      },
    },
  ]);
}

function updateSave(text) {
  $('#save-state').textContent = text;
}

function updateWords() {
  updateStatusBar();
}

async function saveDraft(force = false) {
  if (!state.current) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  updateSave('保存中…');
  try {
    const payload = await api(`/api/chapters/${state.current}/draft`, {
      method: 'PUT',
      body: { content: $('#draft').value, baseHash: force ? undefined : state.cockpit?.draft?.contentHash },
    });
    if (state.cockpit) {
      state.cockpit.draft.text = $('#draft').value;
      state.cockpit.draft.contentHash = payload.hash;
      const meta = state.cockpit.draft.meta;
      if (meta) meta.contentHash = payload.hash;
    }
    state.dirty = false;
    updateSave('已保存');
    updateStatusBar();
    await refreshChapterBadge();
  } catch (error) {
    state.dirty = true;
    updateSave('保存失败');
    toast(error.message, true);
    throw error;
  }
}

async function refreshChapterBadge() {
  const payload = await api('/api/chapters');
  state.chapters = payload.chapters;
  renderShell();
}

async function loadWaivers() {
  const payload = await api('/api/waivers');
  state.waivers = payload.waivers;
}

// ---- Inspector tabs --------------------------------------------------------

function switchTab(tab, persist = true) {
  state.tab = tab;
  if (persist) {
    state.preferences.tab = tab;
    persistPreferences();
  }
  $$('#tabs button').forEach(node => node.classList.toggle('active', node.dataset.tab === tab));
}

async function showEvidence(evidenceId) {
  state.activeEvidence = evidenceId;
  switchTab('evidence');
  await renderInspector();
}

function bindFindingActions() {
  $$('#inspector-body [data-focus-finding]').forEach(node => {
    node.addEventListener('click', () => focusFinding(node.dataset.focusFinding));
  });
  $$('#inspector-body [data-show-evidence]').forEach(node => {
    node.addEventListener('click', () => showEvidence(node.dataset.showEvidence));
  });
  $$('#inspector-body [data-waive]').forEach(node => {
    node.addEventListener('click', () => waiveFinding(node.dataset.waive));
  });
  $$('#inspector-body [data-revise]').forEach(node => {
    node.addEventListener('click', () => reviseFinding(node.dataset.revise));
  });
  $$('#inspector-body [data-ignore]').forEach(node => {
    node.addEventListener('click', () => ignoreFinding(node.dataset.ignore));
  });
}

function bindEvidenceActions() {
  $$('#inspector-body [data-focus-finding]').forEach(node => {
    node.addEventListener('click', () => focusFinding(node.dataset.focusFinding));
  });
  $$('#inspector-body [data-focus-highlight]').forEach(node => {
    node.addEventListener('click', () => focusHighlight(node.dataset.focusHighlight));
  });
  $$('#inspector-body [data-tab-jump]').forEach(node => {
    node.addEventListener('click', async () => {
      switchTab(node.dataset.tabJump);
      await renderInspector();
    });
  });
  $$('#inspector-body [data-evidence-id]').forEach(node => {
    node.addEventListener('click', () => showEvidence(node.dataset.evidenceId));
  });
}

function bindRevisionActions() {
  $$('#inspector-body [data-evidence-id]').forEach(node => {
    node.addEventListener('click', () => showEvidence(node.dataset.evidenceId));
  });
  $$('#inspector-body [data-focus-highlight]').forEach(node => {
    node.addEventListener('click', event => {
      event.stopPropagation();
      focusHighlight(node.dataset.focusHighlight);
    });
  });
  $$('#inspector-body [data-merge]').forEach(node => {
    node.addEventListener('click', event => {
      event.stopPropagation();
      mergeRevision(node.dataset.merge);
    });
  });
  $$('#inspector-body [data-diff]').forEach(node => {
    node.addEventListener('click', event => {
      event.stopPropagation();
      showDiff(node.dataset.diff);
    });
  });
}

async function renderInspector() {
  const payload = state.cockpit;
  if (state.tab === 'ideas') {
    await renderIdeasTab();
    return;
  }
  if (!payload) {
    $('#inspector-body').innerHTML = '<div class="empty">选择章节查看审查结果。</div>';
    return;
  }
  const activeId = state.activeEvidence;
  if (state.tab === 'findings') {
    $('#inspector-body').innerHTML = renderFindings(payload, { escapeHtml, activeId });
    bindFindingActions();
  } else if (state.tab === 'evidence') {
    $('#inspector-body').innerHTML = renderEvidence(payload, { escapeHtml, activeId });
    bindEvidenceActions();
  } else if (state.tab === 'revisions') {
    $('#inspector-body').innerHTML = renderRevisions(payload, { escapeHtml, activeId });
    renderInlineDiff();
    bindRevisionActions();
  } else if (state.tab === 'segments') {
    $('#inspector-body').innerHTML = renderSegmentsTab(payload, escapeHtml);
    bindSegmentActions();
  } else if (state.tab === 'beats') {
    $('#inspector-body').innerHTML = renderBeats(payload, escapeHtml);
  } else if (state.tab === 'context') {
    $('#inspector-body').innerHTML = renderContext(payload, escapeHtml);
  } else if (state.tab === 'stages') {
    $('#inspector-body').innerHTML = renderStages(payload, escapeHtml);
  } else if (state.tab === 'plan') {
    const [plans, outlines] = await Promise.all([api('/api/plans'), api('/api/outlines')]);
    const planCards = plans.plans.map(entry => `
      <div class="card">
        <h3>${escapeHtml(entry.kind)}${entry.kind === 'volume' && entry.content?.volume ? ` ${escapeHtml(entry.content.volume)}` : ''} <span class="muted">${escapeHtml(entry.status)}</span></h3>
        <p class="code">${escapeHtml(entry.path)}</p>
        ${entry.status === 'draft' || entry.status === 'modified'
          ? `<button data-plan-approve="${escapeHtml(entry.kind)}" data-plan-volume="${escapeHtml(entry.content?.volume ?? '')}">批准</button>`
          : ''}
      </div>`).join('');
    const outlineCards = outlines.candidates.length
      ? outlines.candidates.map(candidate => `
        <div class="card">
          <h3>第 ${candidate.chapter} 章 <span class="muted">${escapeHtml(candidate.status)}</span></h3>
          <div class="finding-actions">
            <button data-outline-check="${candidate.chapter}">检查</button>
            <button data-outline-apply="${candidate.chapter}">写入合同</button>
            ${candidate.status !== 'approved' ? `<button data-outline-approve="${candidate.chapter}">批准</button>` : ''}
          </div>
        </div>`).join('')
      : '<div class="empty">还没有生成的章纲候选。</div>';
    $('#inspector-body').innerHTML = `
      <div class="section-label">故事规划</div>
      ${planCards || '<div class="empty">还没有规划文件。</div>'}
      <div class="section-label">章纲候选</div>
      ${outlineCards}`;
    $$('#inspector-body [data-plan-approve]').forEach(node => node.addEventListener('click', async () => {
      try {
        await api('/api/plans/approve', {
          method: 'POST',
          body: { kind: node.dataset.planApprove, volume: node.dataset.planVolume ? Number(node.dataset.planVolume) : undefined },
        });
        toast('已批准规划');
        await renderInspector();
      } catch (error) { toast(error.message, true); }
    }));
    $$('#inspector-body [data-outline-check]').forEach(node => node.addEventListener('click', async () => {
      try {
        const result = await api(`/api/outlines/${node.dataset.outlineCheck}/check`, { method: 'POST' });
        toast(result.ok ? '候选检查通过' : `候选有 ${result.errors.length} 个问题`, !result.ok);
      } catch (error) { toast(error.message, true); }
    }));
    $$('#inspector-body [data-outline-apply]').forEach(node => node.addEventListener('click', async () => {
      try {
        await api(`/api/outlines/${node.dataset.outlineApply}/apply`, { method: 'POST' });
        toast('已写入合同；请运行合同检查后再批准');
        await openChapter(state.current, true);
      } catch (error) { toast(error.message, true); }
    }));
    $$('#inspector-body [data-outline-approve]').forEach(node => node.addEventListener('click', async () => {
      try {
        await api(`/api/outlines/${node.dataset.outlineApprove}/approve`, { method: 'POST' });
        toast('已批准合同');
        await renderInspector();
      } catch (error) { toast(error.message, true); }
    }));
  } else if (state.tab === 'effect') {
    const payload = await api(`/api/chapters/${state.current}/effect-review`);
    const report = payload.report;
    $('#inspector-body').innerHTML = `
      <div class="section-label">阅读效果（仅建议，不阻断定稿）</div>
      ${report
        ? `<p>${escapeHtml(report.summary)}</p>${report.findings.map(finding => `
            <div class="finding ${escapeHtml(finding.severity)}">
              <div class="finding-head"><span>${escapeHtml(finding.dimension)}</span><span>${escapeHtml(finding.severity)}</span></div>
              <p>${escapeHtml(finding.description)}</p>
              ${finding.quote ? `<div class="quote">"${escapeHtml(finding.quote)}"</div>` : ''}
            </div>`).join('')}`
        : '<div class="empty">还没有运行效果审查。</div>'}
      <button id="btn-effect-run">运行效果审查</button>`;
    $('#btn-effect-run').addEventListener('click', async () => {
      try {
        updateSave('效果审查中…');
        await api(`/api/chapters/${state.current}/effect-review`, { method: 'POST' });
        updateSave('已保存');
        await renderInspector();
      } catch (error) {
        updateSave('审查失败');
        toast(error.message, true);
      }
    });
  } else if (state.tab === 'waivers') {
    $('#inspector-body').innerHTML = state.waivers.length
      ? state.waivers.map(waiver => `
        <div class="card">
          <h3>${escapeHtml(waiver.scope)} · ${escapeHtml(waiver.status)}</h3>
          <p>${escapeHtml(waiver.reason)}</p>
          <p class="code">${escapeHtml(waiver.waiverId)}</p>
          ${waiver.status === 'active' ? `<button data-revoke="${escapeHtml(waiver.waiverId)}">撤销</button>` : ''}
        </div>
      `).join('')
      : '<div class="empty">当前项目没有豁免。</div>';
    $$('#inspector-body [data-revoke]').forEach(node => node.addEventListener('click', () => revokeWaiver(node.dataset.revoke)));
  } else if (state.tab === 'methods') {
    const methods = await api(`/api/chapters/${state.current}/methods`);
    $('#inspector-body').innerHTML = methods.modules.length
      ? methods.modules.map(module => `
        <div class="card"><h3>${escapeHtml(module.id)} <span class="muted">v${module.version}</span></h3><p>${escapeHtml(module.reason)}</p></div>
      `).join('') + `<div class="section-label">estimated ${methods.estimatedTokens} tokens</div>`
      : '<div class="empty">本章没有匹配的方法模块。</div>';
  } else if (state.tab === 'style') {
    const style = await api(`/api/chapters/${state.current}/style`);
    $('#inspector-body').innerHTML = `
      <div class="section-label">style constitution</div>
      <pre>${escapeHtml(JSON.stringify(style.style, null, 2))}</pre>
      ${style.findings.length ? style.findings.map(item => `<div class="finding ${item.severity}"><div class="finding-head"><span>${escapeHtml(item.code)}</span><span>${escapeHtml(item.severity)}</span></div><p>${escapeHtml(item.message)}</p></div>`).join('') : '<div class="empty">没有风格偏差。</div>'}
      <div class="section-label">stats</div><pre>${escapeHtml(JSON.stringify(style.stats, null, 2))}</pre>
    `;
  } else if (state.tab === 'history') {
    const history = await api(`/api/chapters/${state.current}/history`);
    $('#inspector-body').innerHTML = history.commits.length
      ? history.commits.map(commit => `
        <div class="card"><h3>r${commit.revision} · ${escapeHtml(commit.commitId.slice(0, 12))}</h3>
          <p>${escapeHtml(commit.createdAt)} · ${commit.evidenceCount} 证据</p>
          <p class="code">${escapeHtml(commit.contentHash.slice(0, 24))}</p>
        </div>`).join('')
      : '<div class="empty">本章还没有正式提交。</div>';
  } else if (state.tab === 'contract') {
    const contract = payload.contract.data;
    $('#inspector-body').innerHTML = contract
      ? `<div class="section-label">chapter contract</div><pre>${escapeHtml(JSON.stringify(contract, null, 2))}</pre><button id="inspector-contract-edit">编辑合同</button>`
      : '<div class="empty">本章没有合同。请用 CLI 创建。</div>';
    const button = $('#inspector-contract-edit');
    if (button) button.addEventListener('click', showContractEditor);
  }
}

// ---- Segments tab ----------------------------------------------------------

const SEGMENT_STATUS_LABELS = {
  missing: '没有计划',
  draft: '草稿',
  modified: '已修改',
  approved: '已批准',
  skipped: '已跳过',
  planned: '待生成',
  generating: '生成中',
  checked: '已检查',
  failed: '失败',
};

function renderSegmentsTab(payload, esc) {
  const view = payload.segmentPlan || { status: 'missing' };
  const plan = view.plan;
  const runtime = new Map((payload.run?.segments || []).map(record => [record.segmentId, record]));
  const stats = new Map((payload.segmentStats || []).map(stat => [stat.segmentId, stat]));
  const status = view.status;
  const header = `<div class="section-label">分段计划 <span class="status-tag status-${esc(status)}">${esc(SEGMENT_STATUS_LABELS[status] || status)}</span></div>`;
  if (!plan) {
    return `${header}<div class="empty">还没有分段计划。先批准场景节拍，再生成计划。</div>
      ${payload.beats.status === 'approved' ? '<button id="btn-segments-plan" class="accent">生成分段计划</button>' : '<div class="muted small">需要先批准场景节拍。</div>'}`;
  }
  const rows = plan.segments.map(segment => {
    const record = runtime.get(segment.segmentId);
    const stat = stats.get(segment.segmentId);
    const segmentStatus = record?.status || stat?.status || segment.status;
    const failed = segmentStatus === 'failed';
    return `<div class="segment-row ${esc(segmentStatus)}">
      <div class="segment-head">
        <strong>${esc(segment.segmentId)}</strong>
        <span class="status-tag status-${esc(segmentStatus)}">${esc(SEGMENT_STATUS_LABELS[segmentStatus] || segmentStatus)}</span>
      </div>
      <p class="small muted">节拍：${esc(segment.beatIds.join('、') || '—')}</p>
      <p class="small">目标 ${segment.targetWords} 字 · 实际 ${stat ? stat.chars : '—'} 字${record?.usage?.totalTokens ? ` · ${record.usage.totalTokens} tokens` : ''}</p>
      <p class="small">${esc(segment.goal)}</p>
      <p class="small muted">入口：${esc(segment.entryState)} → 出口：${esc(segment.exitState)}</p>
      ${failed && payload.run ? `<div class="finding-actions"><button data-segment-resume="${esc(payload.run.runId)}">重试失败段 / 从该段恢复</button></div>` : ''}
    </div>`;
  }).join('');
  const approveButton = status === 'draft' || status === 'modified'
    ? '<button id="btn-segments-approve" class="accent">批准分段计划</button>'
    : '';
  return `${header}
    <div class="card compact">
      <p>合同哈希 ${esc(plan.contractHash.slice(0, 16))}</p>
      <p>计划哈希 ${esc(plan.planHash.slice(0, 16))}</p>
      <p class="muted small">${esc(plan.segments.length)} 段 · 目标 ${plan.targetWords} 字</p>
      ${approveButton}
    </div>
    ${rows}
    <p class="muted small">分段只按批准的计划生成；失败段可恢复，但不会跳过检查直接合并。</p>`;
}

function bindSegmentActions() {
  $('#btn-segments-plan')?.addEventListener('click', () => {
    runChapterAction(`/api/chapters/${state.current}/segments/plan`, '已生成分段计划').catch(error => toast(error.message, true));
  });
  $('#btn-segments-approve')?.addEventListener('click', () => {
    runChapterAction(`/api/chapters/${state.current}/segments/approve`, '已批准分段计划').catch(error => toast(error.message, true));
  });
  $$('#inspector-body [data-segment-resume]').forEach(node => {
    node.addEventListener('click', () => runWriteStream({ strategy: 'segmented', resume: node.dataset.segmentResume }));
  });
}

// ---- Ideas -----------------------------------------------------------------

const IDEA_PROMOTION_TARGETS = [
  ['plan', '计划候选'],
  ['contract', '合同候选'],
  ['outline', '章纲候选'],
  ['canon', '设定候选'],
  ['promise', '读者承诺候选'],
];

async function renderIdeasTab() {
  const [live, archived, map] = await Promise.all([
    api('/api/ideas'),
    api('/api/ideas?status=archived'),
    api('/api/ideas/map'),
  ]);
  const ideas = [...live.ideas, ...archived.ideas];
  $('#inspector-body').innerHTML = renderIdeaPanel(ideas, map, { escapeHtml });
  bindIdeaActions();
}

async function captureIdeaFromBox() {
  const box = $('#idea-capture');
  if (!box) return;
  const body = box.value.trim();
  if (!body) {
    toast('想法正文不能为空', true);
    return;
  }
  try {
    const payload = await api('/api/ideas', { method: 'POST', body: { body } });
    box.value = '';
    toast(`已记下想法：${payload.idea.title}`);
    await renderIdeasTab();
    armIdeaUndo(payload.idea.id);
  } catch (error) {
    toast(error.message, true);
  }
}

function armIdeaUndo(ideaId) {
  clearTimeout(state.ideaUndoTimer);
  const hint = $('#idea-capture-hint');
  if (!hint) return;
  hint.innerHTML = `已保存，5 秒内可撤销 <button id="idea-undo" class="ghost">撤销</button>`;
  $('#idea-undo').addEventListener('click', async () => {
    try {
      await api(`/api/ideas/${ideaId}`, { method: 'DELETE' });
      toast('已撤销该想法');
      clearTimeout(state.ideaUndoTimer);
      await renderIdeasTab();
    } catch (error) {
      toast(error.message, true);
    }
  });
  state.ideaUndoTimer = setTimeout(() => {
    if (hint.isConnected) hint.textContent = '回车保存 · 5 秒内可撤销';
  }, 5000);
}

function bindIdeaActions() {
  $('#idea-save')?.addEventListener('click', captureIdeaFromBox);
  $('#idea-capture')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      captureIdeaFromBox();
    }
  });
  $$('#inspector-body [data-idea-promote]').forEach(node => {
    node.addEventListener('click', () => openIdeaPromotion(node.dataset.ideaPromote).catch(error => toast(error.message, true)));
  });
  $$('#inspector-body [data-idea-archive]').forEach(node => {
    node.addEventListener('click', async () => {
      try {
        await api(`/api/ideas/${node.dataset.ideaArchive}`, { method: 'DELETE' });
        toast('已归档想法（文件保留）');
        await renderIdeasTab();
      } catch (error) { toast(error.message, true); }
    });
  });
  $$('#inspector-body [data-idea-used]').forEach(node => {
    node.addEventListener('click', async () => {
      try {
        const chapters = state.current ? [state.current] : [];
        await api(`/api/ideas/${node.dataset.ideaUsed}/used`, { method: 'POST', body: { chapters } });
        toast(chapters.length ? `已标记为第 ${chapters[0]} 章已用` : '已标记为已用');
        await renderIdeasTab();
      } catch (error) { toast(error.message, true); }
    });
  });
  $$('#inspector-body [data-idea-unused]').forEach(node => {
    node.addEventListener('click', async () => {
      try {
        await api(`/api/ideas/${node.dataset.ideaUnused}/used`, { method: 'DELETE' });
        toast('已取消已用标记');
        await renderIdeasTab();
      } catch (error) { toast(error.message, true); }
    });
  });
  $$('#inspector-body [data-idea-jump]').forEach(node => {
    node.addEventListener('click', () => openChapter(Number(node.dataset.ideaJump)).catch(error => toast(error.message, true)));
  });
}

async function openIdeaPromotion(ideaId) {
  const select = `<select id="idea-promote-target">${IDEA_PROMOTION_TARGETS
    .map(([value, label]) => `<option value="${value}">${label}（${value}）</option>`).join('')}</select>`;
  showModal('晋升想法', `${select}<div id="idea-proposal" class="idea-proposal"><div class="empty">生成候选中…</div></div>`, [
    { label: '取消', action: closeModal },
    { label: '应用', action: () => applyIdeaProposal().catch(error => toast(error.message, true)) },
  ]);
  $('#idea-promote-target').addEventListener('change', event => {
    loadIdeaProposal(ideaId, event.target.value).catch(error => toast(error.message, true));
  });
  await loadIdeaProposal(ideaId, 'plan');
}

async function loadIdeaProposal(ideaId, target) {
  const payload = await api(`/api/ideas/${ideaId}/promote`, { method: 'POST', body: { target } });
  state.pendingProposal = payload.proposal;
  const box = $('#idea-proposal');
  if (box) box.innerHTML = renderPromotionProposal(payload.proposal, { escapeHtml });
}

async function applyIdeaProposal() {
  if (!state.pendingProposal) {
    toast('还没有待应用的晋升提案', true);
    return;
  }
  const ideaId = state.pendingProposal.ideaId;
  await api(`/api/ideas/${ideaId}/apply`, { method: 'POST' });
  state.pendingProposal = null;
  closeModal();
  toast('已应用候选；正式批准仍走现有流程');
  await renderIdeasTab();
}

async function showIdeaMap() {
  try {
    const map = await api('/api/ideas/map');
    showModal('想法地图', renderIdeaMap(map, { escapeHtml }), [{ label: '关闭', action: closeModal }]);
    bindIdeaDetailButtons();
  } catch (error) {
    toast(error.message, true);
  }
}

function bindIdeaDetailButtons() {
  $$('[data-idea-detail]').forEach(node => {
    node.addEventListener('click', async () => {
      try {
        const result = await api(`/api/ideas/${node.dataset.ideaDetail}`);
        showModal(`想法：${result.meta.title}`, renderIdeaDetail(result, { escapeHtml }), [{ label: '关闭', action: closeModal }]);
        bindIdeaDetailButtons();
      } catch (error) { toast(error.message, true); }
    });
  });
}

async function focusIdeaCapture() {
  switchTab('ideas');
  await renderInspector();
  $('#idea-capture')?.focus();
}

// ---- Focus / evidence navigation -------------------------------------------

async function focusFinding(findingId) {
  const finding = state.cockpit?.findings.find(item => item.findingId === findingId);
  if (!finding) return;
  state.activeEvidence = findingHighlightId(finding);
  if (finding.matched === false || finding.charStart == null) {
    toast('定位失效：正文已改动', true);
    switchTab('evidence');
    await renderInspector();
    return;
  }
  try {
    await ensureFreshOffsets();
  } catch {
    return;
  }
  const fresh = state.cockpit.findings.find(item => item.findingId === findingId) ?? finding;
  if (fresh.matched === false || fresh.charStart == null) {
    toast('定位失效：正文已改动', true);
    switchTab('evidence');
    return;
  }
  const ratio = currentScrollRatio();
  state.mode = 'review';
  applyMode({ editor: ratio, view: ratio });
  if (!scrollToHighlight($('#draft-view'), findingHighlightId(fresh))) {
    toast('定位失效：该处高亮与其它意见重叠', true);
  }
  switchTab('evidence');
  await renderInspector();
}

async function focusHighlight(highlightId) {
  if (highlightId.startsWith('finding:')) {
    return focusFinding(highlightId.slice('finding:'.length));
  }
  state.activeEvidence = highlightId;
  try {
    await ensureFreshOffsets();
  } catch {
    return;
  }
  const ratio = currentScrollRatio();
  state.mode = 'review';
  applyMode({ editor: ratio, view: ratio });
  if (!scrollToHighlight($('#draft-view'), highlightId)) {
    toast('定位失效：正文已改动', true);
  }
  switchTab('evidence');
  await renderInspector();
}

function stepFinding(direction) {
  const findings = state.cockpit?.findings ?? [];
  if (findings.length === 0) return;
  const current = findings.findIndex(item => state.activeEvidence === findingHighlightId(item));
  const start = current < 0 ? (direction > 0 ? -1 : 0) : current;
  const next = findings[(start + direction + findings.length) % findings.length];
  if (next) focusFinding(next.findingId);
}

function locateQuote(quote) {
  // Legacy fallback for surfaces that only have a quote. The cockpit path uses offsets.
  const index = state.cockpit?.draft.text.indexOf(quote) ?? -1;
  if (index < 0) {
    toast('当前草稿中找不到该引文', true);
    return;
  }
  const finding = state.cockpit.findings.find(item => item.quote === quote);
  if (finding) focusFinding(finding.findingId);
}

async function showGates() {
  const result = await api(`/api/chapters/${state.current}/gates`);
  if (!result.ready) {
    showModal('定稿门禁未通过', result.gates.map(gate => `
      <div class="finding ${gate.ok ? '' : 'blocking'}">
        <div class="finding-head"><span>${escapeHtml(gate.label)}</span><span>${gate.ok ? '通过' : '阻断'}</span></div>
        <p>${escapeHtml(gate.detail)}</p>
      </div>
    `).join(''), [{ label: '关闭', action: closeModal }]);
  }
  return result;
}

// ---- Stage actions ---------------------------------------------------------

async function runWriteStream(options = {}) {
  if (state.dirty) {
    try {
      await saveDraft();
    } catch {
      return;
    }
  }
  if (state.mode !== 'edit') {
    state.mode = 'edit';
    applyMode();
  }
  const controller = new AbortController();
  state.writeController = controller;
  $('#btn-cancel').classList.remove('hidden');
  updateSave(options.resume ? '从失败段恢复中…' : '生成中…');
  $('#draft').value = '';
  state.offsetsStale = true;
  try {
    const params = new URLSearchParams();
    if (options.strategy) params.set('strategy', options.strategy);
    if (options.resume) params.set('resume', options.resume);
    const query = params.size ? `?${params}` : '';
    const response = await fetch(`/api/chapters/${state.current}/write/stream${query}`, {
      method: 'POST',
      headers: { 'x-weave-token': state.token },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error?.message || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let failed = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const line = block.split('\n').find(item => item.startsWith('data:'));
        if (!line) continue;
        const event = JSON.parse(line.slice(5).trim());
        if (event.type === 'delta') {
          $('#draft').value += event.delta;
          updateWords();
          $('#draft').scrollTop = $('#draft').scrollHeight;
        } else if (event.type === 'error') {
          failed = event;
        }
      }
    }
    if (failed) throw new Error(failed.aborted ? '生成已取消' : failed.message);
    toast('生成完成');
    await openChapter(state.current, true);
  } catch (error) {
    if (error.name === 'AbortError') toast('生成已取消');
    else toast(error.message, true);
    if (state.current) await openChapter(state.current, true).catch(() => {});
  } finally {
    state.writeController = null;
    $('#btn-cancel').classList.add('hidden');
  }
}

async function runStage(action) {
  if (!state.current) return;
  if (action === 'write') {
    await runWriteStream();
    return;
  }
  if (state.dirty) {
    try {
      await saveDraft();
    } catch {
      return;
    }
  }
  if (action === 'finalize') {
    const gates = await showGates();
    if (!gates.ready) return;
    if (!confirm(`确认定稿第 ${state.current} 章？\n草稿 ${(state.cockpit?.draft.contentHash ?? '').slice(0, 16)}`)) return;
  }
  if (action === 'amend' && !confirm('重开草稿会复制当前正式正文，并可能产生新的影响面。继续？')) return;
  const labels = {
    'contract-check': '合同检查', check: '内容检查', extract: '抽取', audit: '审计',
    review: '审查', recheck: '复检', amend: '重开草稿', finalize: '定稿', write: '生成',
  };
  updateSave(`${labels[action] || action}中…`);
  try {
    const path = action === 'contract-check'
      ? `/api/chapters/${state.current}/contract-check`
      : `/api/chapters/${state.current}/stage/${action}`;
    const result = await api(path, { method: 'POST' });
    if (result.exitCode && result.exitCode !== 0) toast(`${labels[action]} 返回 ${result.exitCode}`, true);
    else toast(`${labels[action]}完成`);
    await openChapter(state.current, true);
  } catch (error) {
    updateSave('操作失败');
    toast(error.message, true);
    if (error.details) showModal('错误详情', `<pre>${escapeHtml(JSON.stringify(error.details, null, 2))}</pre>`, []);
  }
}

// ---- Next action state machine ---------------------------------------------

const STAGE_ALIASES = {
  'content-check': 'check',
  extraction: 'extract',
  audit: 'audit',
  review: 'review',
};

async function runNextAction() {
  const next = state.cockpit?.nextAction;
  if (!next) {
    toast('还没有可用的下一步', true);
    return;
  }
  if (next.kind === 'done') {
    toast(next.label || '本章已完成');
    return;
  }
  if (next.kind === 'contract-check') {
    await runStage('contract-check');
    return;
  }
  if (next.kind === 'write') {
    await runWriteStream();
    return;
  }
  if (next.kind === 'revise') {
    switchTab('findings');
    await renderInspector();
    toast('请先处理阻塞问题：修订或豁免');
    return;
  }
  if (next.kind === 'finalize') {
    await runStage('finalize');
    return;
  }
  if (next.kind === 'stage') {
    await runStage(STAGE_ALIASES[next.stage] || next.stage);
    return;
  }
  if (next.kind === 'beats-generate') {
    await runChapterAction(`/api/chapters/${state.current}/beats/generate`, '已生成场景节拍');
    return;
  }
  if (next.kind === 'beats-approve') {
    await runChapterAction(`/api/chapters/${state.current}/beats/approve`, '已批准场景节拍');
    return;
  }
  if (next.kind === 'segments-plan') {
    await runChapterAction(`/api/chapters/${state.current}/segments/plan`, '已生成分段计划');
    return;
  }
  if (next.kind === 'segments-approve') {
    await runChapterAction(`/api/chapters/${state.current}/segments/approve`, '已批准分段计划');
    return;
  }
  toast(`未知的下一步：${next.kind}`, true);
}

async function runChapterAction(path, label) {
  if (!state.current) return;
  updateSave(`${label}…`);
  try {
    await api(path, { method: 'POST' });
    toast(label);
    await openChapter(state.current, true);
  } catch (error) {
    updateSave('操作失败');
    toast(error.message, true);
  }
}

// ---- Findings and revisions actions ---------------------------------------

async function waiveFinding(findingId) {
  const reason = prompt('豁免理由');
  if (!reason) return;
  try {
    await api('/api/waivers', { method: 'POST', body: { chapter: state.current, findingIds: [findingId], reason, scope: 'chapter' } });
    toast('已创建豁免');
    await openChapter(state.current, true);
  } catch (error) { toast(error.message, true); }
}

async function reviseFinding(findingId) {
  try {
    const result = await api(`/api/chapters/${state.current}/revise`, { method: 'POST', body: { findings: [findingId] } });
    toast(`已生成修订 ${result.candidate.revisionId}`);
    switchTab('revisions');
    await openChapter(state.current, true);
  } catch (error) { toast(error.message, true); }
}

async function mergeRevision(revisionId) {
  try {
    let result = await api(`/api/chapters/${state.current}/merge`, { method: 'POST', body: { revisionId } });
    if (result.status === 'conflict') {
      const choices = {};
      for (const hunk of result.hunks.filter(item => item.status === 'conflict')) {
        const choice = prompt(`${hunk.paragraphId} 冲突：输入 base / revision / manual`, 'manual');
        if (choice && ['base', 'revision', 'manual'].includes(choice)) choices[hunk.paragraphId] = choice;
      }
      if (Object.keys(choices).length === 0) return toast('合并仍有冲突', true);
      result = await api(`/api/chapters/${state.current}/merge`, { method: 'POST', body: { revisionId, choices } });
    }
    toast('已合并修订');
    await openChapter(state.current, true);
  } catch (error) { toast(error.message, true); }
}

async function ignoreFinding(findingId) {
  const reason = prompt('忽略理由');
  if (!reason) return;
  try {
    await api(`/api/chapters/${state.current}/ignore`, { method: 'POST', body: { findingId, reason } });
    toast('已忽略');
    await openChapter(state.current, true);
  } catch (error) { toast(error.message, true); }
}

async function revokeWaiver(waiverId) {
  try {
    await api(`/api/waivers/${encodeURIComponent(waiverId)}`, { method: 'DELETE' });
    toast('已撤销豁免');
    await openChapter(state.current, true);
  } catch (error) { toast(error.message, true); }
}

async function showDiff(revisionId) {
  let revision = state.cockpit?.revisions?.find(item => item.revisionId === revisionId);
  if (!revision) return;
  if (!Array.isArray(revision.paragraphs)) {
    const payload = await api(`/api/chapters/${state.current}/revisions`);
    revision = payload.revisions.find(item => item.revisionId === revisionId) ?? revision;
  }
  const paragraphs = Array.isArray(revision.paragraphs) ? revision.paragraphs : [];
  const before = new Map((revision.baseParagraphs || []).map(item => [item.paragraphId, item.text]));
  state.inlineDiff = { revisionId, paragraphs, before };
  switchTab('revisions');
  await renderInspector();
}

function renderInlineDiff() {
  const body = $('#inspector-body');
  if (!body) return;
  const toolbar = `<div class="inline-diff-toolbar">
    <button id="btn-compare-commit" class="ghost">对比定稿</button>
    <span class="muted small">只读；采纳仍走合并</span>
  </div>`;
  let html = toolbar;
  if (state.inlineDiff) {
    const { revisionId, paragraphs, before } = state.inlineDiff;
    const rows = paragraphs.map(item => {
      const prior = before.get(item.paragraphId) || '';
      return `<div class="inline-diff-row"><div class="section-label">${escapeHtml(item.paragraphId)}</div>
        <pre class="diff-before">- ${escapeHtml(prior)}</pre>
        <pre class="diff-after">+ ${escapeHtml(item.text)}</pre></div>`;
    }).join('');
    html += `<div class="inline-diff"><div class="section-label">修订 diff · ${escapeHtml(revisionId)}</div>
      ${rows || '<div class="empty">该修订没有段落内容。</div>'}
      <div class="finding-actions"><button data-merge="${escapeHtml(revisionId)}">采纳（合并）</button>
        <button id="inline-diff-close" class="ghost">收起 diff</button></div></div>`;
  }
  if (state.compare) {
    const rows = state.compare.rows.map(row => {
      const cls = row.status === 'same' ? 'same' : row.status;
      return `<div class="compare-row ${cls}"><span class="compare-tag">${escapeHtml(row.status)}</span>
        <pre class="diff-before">${row.before === null ? '' : `- ${escapeHtml(row.before)}`}</pre>
        <pre class="diff-after">${row.after === null ? '' : `+ ${escapeHtml(row.after)}`}</pre></div>`;
    }).join('');
    html += `<div class="inline-diff"><div class="section-label">草稿 vs 定稿 r${state.compare.base.revision}</div>
      ${rows || '<div class="empty">两边都没有段落。</div>'}
      <p class="muted small">草稿 ${escapeHtml(state.compare.draft.contentHash.slice(0, 12))} · 定稿 ${escapeHtml(state.compare.base.contentHash.slice(0, 12))}</p>
      <button id="inline-diff-close" class="ghost">收起对比</button></div>`;
  }
  body.innerHTML += html;
  $('#inline-diff-close')?.addEventListener('click', async () => {
    state.inlineDiff = null;
    state.compare = null;
    await renderInspector();
  });
  $('#btn-compare-commit')?.addEventListener('click', () => loadCommitCompare().catch(error => toast(error.message, true)));
}

async function loadCommitCompare() {
  const result = await api(`/api/chapters/${state.current}/compare?base=commit`);
  state.compare = result;
  await renderInspector();
}

function showModal(title, body, actions) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-actions').innerHTML = '';
  for (const action of actions) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.addEventListener('click', action.action);
    $('#modal-actions').append(button);
  }
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

// ---- Search / tools --------------------------------------------------------

async function openSearch() {
  $('#drawer').classList.remove('hidden');
  $('#search-q').focus();
  $('#search-results').innerHTML = '';
}

async function runSearch() {
  const query = $('#search-q').value.trim();
  if (!query) { $('#search-results').innerHTML = ''; return; }
  const params = new URLSearchParams({ q: query });
  for (const [key, selector] of [['entity', '#search-entity'], ['location', '#search-location'], ['storyline', '#search-storyline'], ['time', '#search-time']]) {
    const value = $(selector).value.trim();
    if (value) params.set(key, value);
  }
  const payload = await api(`/api/search?${params}`);
  $('#search-results').innerHTML = payload.results.length
    ? payload.results.map(result => `
      <div class="result" data-chunk="${escapeHtml(result.chunkId)}">
        <div class="meta">第 ${result.chapter} 章 · 第 ${result.paragraph} 段 · ${escapeHtml(result.fusion || '')}</div>
        <p>${escapeHtml(result.text)}</p>
      </div>
    `).join('')
    : '<div class="empty">没有命中。</div>';
  $$('#search-results [data-chunk]').forEach(node => node.addEventListener('click', async () => {
    const payload = await api(`/api/chunks/${node.dataset.chunk}`).catch(() => null);
    if (payload) showModal('父块回读', `<pre>${escapeHtml(payload.parentText)}</pre>`, [{ label: '关闭', action: closeModal }]);
  }));
}

async function showDeconstruct() {
  const file = prompt('项目内的 txt/md/epub 路径（相对于项目根目录）');
  if (!file) return;
  try {
    const result = await api('/api/deconstruct', { method: 'POST', body: { path: file } });
    showModal('拆书结构报告', `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`, [{ label: '关闭', action: closeModal }]);
  } catch (error) { toast(error.message, true); }
}

async function showDoctor() {
  try {
    const result = await api('/api/doctor');
    showModal('项目体检', `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`, [{ label: '关闭', action: closeModal }]);
  } catch (error) { toast(error.message, true); }
}

async function showExport() {
  const format = prompt('导出格式：merged / split / txt', 'merged');
  if (!format) return;
  const platform = prompt('平台：generic / qidian / fanqie / custom', 'generic');
  if (!platform) return;
  try {
    const result = await api('/api/export', { method: 'POST', body: { format, platform } });
    toast(`已导出 ${result.characters} 字`);
    showModal('导出完成', `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`, [{ label: '关闭', action: closeModal }]);
  } catch (error) { toast(error.message, true); }
}

// ---- Selection revisions ----------------------------------------------------

function updateSelectionTools() {
  const editor = $('#draft');
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  $('#selection-tools').classList.toggle('hidden', !selected.trim());
}

function selectedOccurrence(editor, selected) {
  const before = editor.value.slice(0, editor.selectionStart);
  let occurrence = 0;
  let index = before.indexOf(selected);
  while (index >= 0) {
    occurrence += 1;
    index = before.indexOf(selected, index + selected.length);
  }
  return occurrence + 1;
}

async function createSelectionRevision(operation) {
  if (state.selectionBusy || !state.current) return;
  const editor = $('#draft');
  const selectedText = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (!selectedText.trim()) return;
  const occurrence = selectedOccurrence(editor, selectedText);
  const instruction = operation === 'custom' ? prompt('输入这段文字的修改要求') : undefined;
  if (operation === 'custom' && !instruction?.trim()) return;
  state.selectionBusy = true;
  updateSave('生成划词候选…');
  try {
    await saveDraft();
    const payload = await api(`/api/chapters/${state.current}/selection-revisions`, {
      method: 'POST',
      body: {
        baseDraftHash: state.cockpit?.draft.contentHash,
        selectedText,
        occurrence,
        operation,
        ...(instruction ? { instruction } : {}),
      },
    });
    await refreshCockpit();
    showSelectionCandidate(payload.candidate);
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.selectionBusy = false;
    updateSave('已保存');
  }
}

function showSelectionCandidate(candidate) {
  const selection = candidate.selection;
  const body = `
    <p class="muted small">${escapeHtml(selection.operation)} · 仅替换选区，不自动定稿</p>
    <div class="selection-diff">
      <section><div class="section-label">原文</div><pre>${escapeHtml(selection.selectedText)}</pre></section>
      <section><div class="section-label">候选</div><pre>${escapeHtml(selection.replacement)}</pre></section>
    </div>`;
  showModal('划词候选', body, [
    { label: '采纳', action: () => mergeSelectionCandidate(candidate.revisionId) },
    { label: '废弃', action: () => discardSelectionCandidate(candidate.revisionId) },
    { label: '关闭', action: closeModal },
  ]);
}

async function mergeSelectionCandidate(revisionId) {
  try {
    const report = await api(`/api/chapters/${state.current}/merge`, {
      method: 'POST',
      body: { revisionId },
    });
    if (report.status !== 'merged') {
      toast('草稿已变化，旧候选不能覆盖新内容；请重新划词生成。', true);
      return;
    }
    closeModal();
    await openChapter(state.current, true);
  } catch (error) {
    toast(error.message, true);
  }
}

async function discardSelectionCandidate(revisionId) {
  try {
    await api(`/api/chapters/${state.current}/selection-discard`, {
      method: 'POST',
      body: { revisionId },
    });
    closeModal();
    await refreshCockpit();
  } catch (error) {
    toast(error.message, true);
  }
}

// ---- Blind pairwise reading -------------------------------------------------
// The page never receives which strategy produced a side; the server keeps mapping sealed.

function evalPath(suffix = '') {
  return `/api/evals/${encodeURIComponent(state.eval.sessionId)}${suffix}`;
}

function proseHtml(text) {
  return String(text || '').split(/\n+/).map(line => line.trim()).filter(Boolean)
    .map(line => `<p>${escapeHtml(line)}</p>`).join('');
}

async function showEvalSessions() {
  try {
    const payload = await api('/api/evals');
    if (!payload.sessions.length) {
      showModal('盲评', '<p class="muted">还没有盲评会话。先用 benchmark 生成匿名对照，再运行 <code>weave eval import &lt;pairsDir&gt;</code> 导入。</p>', [{ label: '关闭', action: closeModal }]);
      return;
    }
    const body = payload.sessions.map(item => `
      <div class="eval-session">
        <div><strong>${escapeHtml(item.title)}</strong><div class="muted small">${escapeHtml(item.sessionId)} · 已评 ${item.scored}/${item.total}${item.sealed ? '' : ' · 无 mapping'}</div></div>
        <div><button data-eval-open="${escapeHtml(item.sessionId)}" class="accent">${item.scored < item.total ? '继续阅读' : '再看一遍'}</button>
        <button data-eval-result="${escapeHtml(item.sessionId)}">结果</button></div>
      </div>`).join('');
    showModal('盲评会话', body, [{ label: '关闭', action: closeModal }]);
    $$('#modal-body [data-eval-open]').forEach(node => node.addEventListener('click', () => openEval(node.dataset.evalOpen, node.closest('.eval-session').querySelector('strong').textContent)));
    $$('#modal-body [data-eval-result]').forEach(node => node.addEventListener('click', () => {
      state.eval = { sessionId: node.dataset.evalResult };
      showEvalReport().catch(error => toast(error.message, true));
    }));
  } catch (error) { toast(error.message, true); }
}

async function openEval(sessionId, title) {
  state.eval = { sessionId, title, pair: null, stopLeft: '', stopRight: '' };
  closeModal();
  $('#eval-title').textContent = title || sessionId;
  $('#eval-view').classList.remove('hidden');
  await loadNextPair().catch(error => toast(error.message, true));
}

async function loadNextPair() {
  const payload = await api(evalPath('/next'));
  state.eval.pair = payload.pair;
  state.eval.stopLeft = '';
  state.eval.stopRight = '';
  $('#eval-note').value = '';
  $('#eval-stop-Left').textContent = '';
  $('#eval-stop-Right').textContent = '';
  $('#eval-progress').textContent = `已评 ${payload.progress.scored}/${payload.progress.total}`;
  const done = !payload.pair;
  $$('#eval-view [data-eval-winner], #eval-view [data-eval-stop]').forEach(node => { node.disabled = done; });
  if (done) {
    $('#eval-left').innerHTML = '<p class="muted">这一组已经全部评完。</p>';
    $('#eval-right').innerHTML = '<p class="muted">点"查看结果"解封胜率。</p>';
    return;
  }
  $('#eval-left').innerHTML = proseHtml(payload.pair.left);
  $('#eval-right').innerHTML = proseHtml(payload.pair.right);
  $('#eval-left').scrollTop = 0;
  $('#eval-right').scrollTop = 0;
}

function markEvalStop(side) {
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : '';
  const column = $(side === 'Left' ? '#eval-left' : '#eval-right');
  if (!text || !selection.anchorNode || !column.contains(selection.anchorNode)) {
    toast(`先在${side === 'Left' ? '左' : '右'}栏选中你想停下的那一句`, true);
    return;
  }
  state.eval[`stop${side}`] = text;
  $(`#eval-stop-${side}`).textContent = `弃读点：${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
}

async function submitEvalScore(winner) {
  if (!state.eval?.pair) return;
  try {
    await api(evalPath('/scores'), {
      method: 'POST',
      body: {
        pairId: state.eval.pair.pairId,
        winner,
        note: $('#eval-note').value,
        stopLeft: state.eval.stopLeft || undefined,
        stopRight: state.eval.stopRight || undefined,
      },
    });
    await loadNextPair();
  } catch (error) { toast(error.message, true); }
}

async function showEvalReport(force = false) {
  const report = await api(evalPath(`/report${force ? '?force=1' : ''}`));
  const labels = report.labels || {};
  const body = report.revealed
    ? `<p>已评 ${report.scored}/${report.total}${report.complete ? '' : '（提前解封）'}</p>
       <p>A（${escapeHtml(labels.a || 'a')}）胜 ${report.wins.a} · B（${escapeHtml(labels.b || 'b')}）胜 ${report.wins.b} · 平 ${report.ties}</p>
       <p>A 胜率：${report.winRateA === null ? '无决定性结果' : `${Math.round(report.winRateA * 100)}%`}</p>
       <p>弃读点：A ${report.stopPoints.a ?? 0} 处 · B ${report.stopPoints.b ?? 0} 处</p>
       <p class="muted small">${escapeHtml(report.note)}</p>`
    : `<p>已评 ${report.scored}/${report.total}，平 ${report.ties}。</p><p class="muted small">${escapeHtml(report.note)}</p>`;
  const actions = [{ label: '关闭', action: closeModal }];
  if (!report.revealed && report.scored > 0) {
    actions.unshift({ label: '提前解封', action: () => showEvalReport(true).catch(error => toast(error.message, true)) });
  }
  showModal('盲评结果', body, actions);
}

// ---- Command palette -------------------------------------------------------

function commandList() {
  const hasChapter = Boolean(state.current);
  const chapter = () => state.current;
  return [
    { id: 'open-next', label: '打开下一章', hint: '章节', enabled: hasChapter, run: () => openChapter((chapter() ?? 0) + 1).catch(error => toast(error.message, true)) },
    { id: 'open-prev', label: '打开上一章', hint: '章节', enabled: hasChapter && (chapter() ?? 1) > 1, run: () => openChapter(Math.max(1, (chapter() ?? 1) - 1)).catch(error => toast(error.message, true)) },
    { id: 'contract-check', label: '运行合同检查', hint: '门禁', enabled: hasChapter, run: () => runStage('contract-check') },
    { id: 'beats-generate', label: '生成场景节拍', hint: '节拍', enabled: hasChapter, run: () => runChapterAction(`/api/chapters/${state.current}/beats/generate`, '已生成场景节拍') },
    { id: 'beats-approve', label: '批准场景节拍', hint: '节拍', enabled: hasChapter, run: () => runChapterAction(`/api/chapters/${state.current}/beats/approve`, '已批准场景节拍') },
    { id: 'segments-plan', label: '生成分段计划', hint: '分段', enabled: hasChapter, run: () => runChapterAction(`/api/chapters/${state.current}/segments/plan`, '已生成分段计划') },
    { id: 'segments-approve', label: '批准分段计划', hint: '分段', enabled: hasChapter, run: () => runChapterAction(`/api/chapters/${state.current}/segments/approve`, '已批准分段计划') },
    { id: 'write', label: '写本章（流式）', hint: '生成', enabled: hasChapter, run: () => runWriteStream() },
    { id: 'check', label: '运行内容检查', hint: '阶段', enabled: hasChapter, run: () => runStage('check') },
    { id: 'extract', label: '运行证据抽取', hint: '阶段', enabled: hasChapter, run: () => runStage('extract') },
    { id: 'audit', label: '运行覆盖审计', hint: '阶段', enabled: hasChapter, run: () => runStage('audit') },
    { id: 'review', label: '运行审查', hint: '阶段', enabled: hasChapter, run: () => runStage('review') },
    { id: 'finalize', label: '定稿本章', hint: '门禁', enabled: hasChapter, run: () => runStage('finalize') },
    { id: 'capture-idea', label: '捕获想法', hint: '想法', enabled: true, run: () => focusIdeaCapture().catch(error => toast(error.message, true)) },
    { id: 'idea-map', label: '打开想法地图', hint: '想法', enabled: true, run: () => showIdeaMap() },
    { id: 'search', label: '全文搜索', hint: '工具', enabled: true, run: () => openSearch() },
    { id: 'export', label: '导出', hint: '工具', enabled: true, run: () => showExport() },
    { id: 'doctor', label: '项目体检', hint: '工具', enabled: true, run: () => showDoctor() },
    { id: 'refresh', label: '刷新', hint: '工具', enabled: true, run: () => refresh().catch(error => toast(error.message, true)) },
    { id: 'toggle-mode', label: '切换编辑/审阅', hint: '视图', enabled: hasChapter, run: () => toggleMode().catch(error => toast(error.message, true)) },
  ];
}

const paletteState = { open: false, items: [], active: 0 };

function openPalette() {
  paletteState.open = true;
  paletteState.active = 0;
  $('#palette').classList.remove('hidden');
  const input = $('#palette-q');
  input.value = '';
  input.focus();
  renderPalette();
}

function closePalette() {
  paletteState.open = false;
  $('#palette').classList.add('hidden');
}

function renderPalette() {
  const query = ($('#palette-q').value || '').trim().toLowerCase();
  const items = commandList().filter(item => !query || item.label.toLowerCase().includes(query) || item.hint.toLowerCase().includes(query));
  paletteState.items = items;
  if (paletteState.active >= items.length) paletteState.active = Math.max(0, items.length - 1);
  $('#palette-list').innerHTML = items.length
    ? items.map((item, index) => `
      <div class="palette-item ${item.enabled ? '' : 'disabled'} ${index === paletteState.active ? 'active' : ''}" data-palette-index="${index}">
        <span>${escapeHtml(item.label)}</span>
        <span class="palette-hint">${escapeHtml(item.hint)}</span>
      </div>`).join('')
    : '<div class="empty">没有匹配的命令。</div>';
  $$('#palette-list [data-palette-index]').forEach(node => {
    node.addEventListener('click', () => executePalette(Number(node.dataset.paletteIndex)));
  });
}

function executePalette(index) {
  const item = paletteState.items[index];
  if (!item || !item.enabled) return;
  closePalette();
  Promise.resolve(item.run()).catch(error => toast(error.message, true));
}

function movePalette(delta) {
  if (!paletteState.open || paletteState.items.length === 0) return;
  paletteState.active = (paletteState.active + delta + paletteState.items.length) % paletteState.items.length;
  renderPalette();
}

function bindPalette() {
  $('#palette-q').addEventListener('input', () => {
    paletteState.active = 0;
    renderPalette();
  });
  $('#palette-q').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      movePalette(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      movePalette(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      executePalette(paletteState.active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  });
  $('#palette').addEventListener('click', event => {
    if (event.target === $('#palette')) closePalette();
  });
}

// ---- Bind ------------------------------------------------------------------

function bind() {
  $('#draft').addEventListener('select', updateSelectionTools);
  $('#draft').addEventListener('keyup', updateSelectionTools);
  $('#draft').addEventListener('mouseup', updateSelectionTools);
  $('#draft').addEventListener('input', () => $('#selection-tools').classList.add('hidden'));
  $$('[data-selection-op]').forEach(node => node.addEventListener('click', () => createSelectionRevision(node.dataset.selectionOp)));
  $('#draft').addEventListener('input', () => {
    state.dirty = true;
    state.offsetsStale = true;
    updateWords();
    updateSave('未保存');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveDraft(), 900);
  });
  $('#btn-mode').addEventListener('click', () => toggleMode().catch(error => toast(error.message, true)));
  $('#btn-next').addEventListener('click', () => runNextAction().catch(error => toast(error.message, true)));
  $$('#stagebar button[data-stage]').forEach(node => node.addEventListener('click', () => runStage(node.dataset.stage)));
  $('#btn-cancel').addEventListener('click', () => state.writeController?.abort());
  $('#btn-refresh').addEventListener('click', () => refresh().catch(error => toast(error.message, true)));
  $('#btn-deconstruct').addEventListener('click', showDeconstruct);
  $('#btn-doctor').addEventListener('click', showDoctor);
  $('#btn-export').addEventListener('click', showExport);
  $('#btn-search').addEventListener('click', openSearch);
  $('#btn-ideas-map').addEventListener('click', showIdeaMap);
  $('#btn-eval').addEventListener('click', showEvalSessions);
  $('#eval-close').addEventListener('click', () => $('#eval-view').classList.add('hidden'));
  $('#eval-report').addEventListener('click', () => showEvalReport().catch(error => toast(error.message, true)));
  $$('#eval-view [data-eval-winner]').forEach(node => node.addEventListener('click', () => submitEvalScore(node.dataset.evalWinner)));
  $$('#eval-view [data-eval-stop]').forEach(node => node.addEventListener('click', () => markEvalStop(node.dataset.evalStop)));
  $('#drawer-close').addEventListener('click', () => $('#drawer').classList.add('hidden'));
  $('#modal-close').addEventListener('click', closeModal);
  $('#search-form').addEventListener('submit', event => { event.preventDefault(); runSearch().catch(error => toast(error.message, true)); });
  $$('#chapter-filters button').forEach(node => node.addEventListener('click', () => {
    state.filter = node.dataset.filter;
    renderShell();
  }));
  $$('#tabs button').forEach(node => node.addEventListener('click', () => {
    switchTab(node.dataset.tab);
    renderInspector().catch(error => toast(error.message, true));
  }));
  bindPalette();
  document.addEventListener('keydown', event => {
    const typing = ['TEXTAREA', 'INPUT'].includes(event.target?.tagName);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      if (paletteState.open) closePalette();
      else openPalette();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      runNextAction().catch(error => toast(error.message, true));
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveDraft().catch(error => toast(error.message, true));
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      toggleMode().catch(error => toast(error.message, true));
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      focusIdeaCapture().catch(error => toast(error.message, true));
    }
    if (!typing && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      stepFinding(1);
    }
    if (!typing && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      stepFinding(-1);
    }
    if (event.key === 'Escape') { closeModal(); closePalette(); $('#drawer').classList.add('hidden'); }
  });
  window.addEventListener('resize', () => {
    if (state.mode === 'review') renderDraftViewMarkup();
  });
}

async function persistPreferences() {
  try {
    await api('/api/preferences', {
      method: 'PUT',
      body: { lastChapter: state.preferences.lastChapter, tab: state.tab, theme: 'dark' },
    });
  } catch {
    // Preference persistence must never block editing.
  }
}

async function boot() {
  const bootstrap = await api('/api/bootstrap');
  state.token = bootstrap.token;
  state.status = bootstrap.status;
  state.preferences = bootstrap.preferences || {};
  if (typeof state.preferences.tab === 'string') state.tab = state.preferences.tab;
  $$('#tabs button').forEach(node => node.classList.toggle('active', node.dataset.tab === state.tab));
  bind();
  await refresh();
}

boot().catch(error => {
  document.body.innerHTML = `<pre style="color:#e7a096;padding:24px">工作台启动失败\n${escapeHtml(error.message)}</pre>`;
});
