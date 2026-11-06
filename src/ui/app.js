const state = {
  token: '',
  status: null,
  chapters: [],
  current: null,
  detail: null,
  tab: 'findings',
  dirty: false,
  saveTimer: null,
  waivers: [],
  preferences: {},
  writeController: null,
  selectionBusy: false,
  eval: null,
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

function statusLabel(chapter) {
  if (chapter.finalized) return '定稿';
  if (chapter.blocking) return '阻断';
  if (chapter.status === 'reviewed') return '已审查';
  if (chapter.draft) return '草稿';
  return '计划';
}

function renderShell() {
  const status = state.status;
  if (!status) return;
  $('#project-title').textContent = status.title;
  $('#project-subtitle').textContent = `主线 r${status.mainlineRevision} · ${status.chapters.length} 章定稿 · ${status.drafts.length} 草稿`;
  $('#project-flags').textContent = `内容投影 ${status.projection?.status ?? '无'} · 账本投影 ${status.ledgerProjection?.status ?? '无'} · 未处理影响 ${status.pendingImpacts}`;
  $('#chapter-count').textContent = String(state.chapters.length);
  $('#chapter-list').innerHTML = state.chapters.map(chapter => `
    <div class="chapter-item ${state.current === chapter.chapter ? 'active' : ''}" data-chapter="${chapter.chapter}">
      <span class="num">${String(chapter.chapter).padStart(3, '0')}</span>
      <span class="name">${escapeHtml(chapter.title || `第 ${chapter.chapter} 章`)}</span>
      <span>${chapter.blocking ? `<span class="badge">${chapter.blocking}</span>` : `<span class="dot ${chapter.finalized ? 'finalized' : chapter.draft ? 'draft' : ''}"></span>`}</span>
    </div>
  `).join('');
  $$('.chapter-item').forEach(node => node.addEventListener('click', () => openChapter(Number(node.dataset.chapter))));
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

async function openChapter(chapter, silent = false) {
  if (!silent && state.dirty && !confirm('当前草稿还有未保存修改，切换章节会丢失。继续？')) return;
  state.current = chapter;
  state.detail = await api(`/api/chapters/${chapter}`);
  state.preferences.lastChapter = chapter;
  await persistPreferences();
  const detail = state.detail;
  const contract = detail.contract;
  $('#chapter-eyebrow').textContent = `第 ${chapter} 章 · ${detail.stages.review?.passed ? '审查通过' : detail.stages.review ? '存在意见' : '未审查'}`;
  $('#chapter-title').textContent = contract?.title || `第 ${chapter} 章`;
  $('#draft').value = detail.draft || '';
  updateSelectionTools();
  $('#draft-hash').textContent = detail.hash ? detail.hash.slice(0, 18) : '';
  clearTimeout(state.saveTimer);
  state.dirty = false;
  state.saveTimer = null;
  updateSave('已保存');
  updateWords();
  renderContract(contract);
  renderShell();
  await Promise.all([renderInspector(), loadWaivers()]);
}

function renderContract(contract) {
  if (!contract) {
    $('#contract-strip').innerHTML = '<span class="muted">本章还没有合同。请用 CLI 创建合同后再开始。</span>';
    return;
  }
  $('#contract-strip').innerHTML = [
    `目标：${escapeHtml(contract.goal)}`,
    `阻力：${escapeHtml(contract.obstacle || '—')}`,
    `视角：${escapeHtml(contract.pov)}`,
    `地点：${escapeHtml(contract.location)}`,
    `字数：${escapeHtml(contract.targetWords)}`,
    `必须：${escapeHtml((contract.mustHappen || []).join('；') || '—')}`,
    '<button id="btn-contract" class="ghost">编辑合同</button>',
  ].map(text => text.startsWith('<button') ? text : `<span>${text}</span>`).join('');
  $('#btn-contract').addEventListener('click', showContractEditor);
}

function showContractEditor() {
  const contract = state.detail?.contract;
  if (!contract) return;
  showModal('编辑合同', `<textarea id="contract-json" spellcheck="false">${escapeHtml(JSON.stringify(contract, null, 2))}</textarea>`, [
    { label: '取消', action: closeModal },
    {
      label: '保存',
      action: async () => {
        try {
          const next = JSON.parse($('#contract-json').value);
          const saved = await api(`/api/chapters/${state.current}/contract`, { method: 'PUT', body: next });
          closeModal();
          state.detail.contract = saved;
          renderContract(saved);
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
  const text = $('#draft').value || '';
  $('#word-count').textContent = `${[...text.replace(/\s/g, '')].length} 字`;
}

async function saveDraft(force = false) {
  if (!state.current) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  updateSave('保存中…');
  try {
    const payload = await api(`/api/chapters/${state.current}/draft`, {
      method: 'PUT',
      body: { content: $('#draft').value, baseHash: force ? undefined : state.detail.hash },
    });
    state.detail.hash = payload.hash;
    state.detail.draft = $('#draft').value;
    state.dirty = false;
    $('#draft-hash').textContent = payload.hash.slice(0, 18);
    updateSave('已保存');
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

async function renderInspector() {
  const detail = state.detail;
  if (!detail) {
    $('#inspector-body').innerHTML = '<div class="empty">选择章节查看审查结果。</div>';
    return;
  }
  if (state.tab === 'findings') {
    const review = detail.stages.review;
    const findings = review?.findings || [];
    $('#inspector-body').innerHTML = findings.length
      ? findings.map(finding => `
        <div class="finding ${finding.severity}">
          <div class="finding-head"><span>${escapeHtml(finding.dimension)} · ${escapeHtml(finding.severity)}</span><span>${escapeHtml(finding.status)}</span></div>
          <p>${escapeHtml(finding.description)}</p>
          ${finding.quote ? `<div class="quote">"${escapeHtml(finding.quote)}"</div>` : ''}
          ${finding.waiveReason ? `<p class="small">豁免：${escapeHtml(finding.waiveReason)}</p>` : ''}
          <div class="finding-actions">
            ${finding.quote ? `<button data-locate="${escapeHtml(finding.quote)}">定位</button>` : ''}
            ${finding.severity === 'warning' && finding.status !== 'waived' ? `<button data-waive="${escapeHtml(finding.findingId)}">豁免</button>` : ''}
            ${finding.severity === 'blocking' && ['open', 'planned'].includes(finding.status) ? `<button data-revise="${escapeHtml(finding.findingId)}">发起修订</button>` : ''}
            ${finding.severity !== 'blocking' ? `<button data-ignore="${escapeHtml(finding.findingId)}">忽略</button>` : ''}
          </div>
        </div>
      `).join('')
      : `<div class="empty">${review ? '审查通过，没有 finding。' : '尚未运行审查。'}</div>`;
    $$('#inspector-body [data-locate]').forEach(node => node.addEventListener('click', () => locateQuote(node.dataset.locate)));
    $$('#inspector-body [data-waive]').forEach(node => node.addEventListener('click', () => waiveFinding(node.dataset.waive)));
    $$('#inspector-body [data-revise]').forEach(node => node.addEventListener('click', () => reviseFinding(node.dataset.revise)));
    $$('#inspector-body [data-ignore]').forEach(node => node.addEventListener('click', () => ignoreFinding(node.dataset.ignore)));
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
  } else if (state.tab === 'stages') {
    const stages = detail.stages || {};
    const block = (title, report, extra = '') => `
      <div class="card"><h3>${title}</h3>
        <p>${report ? `${extra}${report.passed ? '通过' : '未通过'}` : '缺失'}</p>
        ${report ? `<pre>${escapeHtml(JSON.stringify(report, null, 2).slice(0, 9000))}</pre>` : ''}
      </div>`;
    $('#inspector-body').innerHTML = [
      block('内容检查', stages.contentCheck, `${stages.contentCheck?.stats?.characters ?? 0} 字 · `),
      block('证据抽取', stages.extraction, `${stages.extraction?.records?.length ?? 0} 条 · `),
      block('覆盖审计', stages.audit, `${stages.audit?.contract?.covered?.length ?? 0} 项覆盖 · `),
    ].join('');
  } else if (state.tab === 'revisions') {
    const revisions = detail.revisions || [];
    $('#inspector-body').innerHTML = revisions.length
      ? revisions.map(revision => `
        <div class="card">
          <h3>${escapeHtml(revision.revisionId)}</h3>
          <p>${escapeHtml(revision.createdAt)} · ${revision.paragraphs.length} 段候选</p>
          <div class="finding-actions">
            <button data-merge="${escapeHtml(revision.revisionId)}">合并</button>
            <button data-diff="${escapeHtml(revision.revisionId)}">查看 diff</button>
          </div>
        </div>
      `).join('')
      : '<div class="empty">还没有修订候选。blocking finding 可以在"意见"里发起修订。</div>';
    $$('#inspector-body [data-merge]').forEach(node => node.addEventListener('click', () => mergeRevision(node.dataset.merge)));
    $$('#inspector-body [data-diff]').forEach(node => node.addEventListener('click', () => showDiff(node.dataset.diff)));
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
    const contract = detail.contract;
    $('#inspector-body').innerHTML = contract
      ? `<div class="section-label">chapter contract</div><pre>${escapeHtml(JSON.stringify(contract, null, 2))}</pre><button id="inspector-contract-edit">编辑合同</button>`
      : '<div class="empty">本章没有合同。请用 CLI 创建。</div>';
    const button = $('#inspector-contract-edit');
    if (button) button.addEventListener('click', showContractEditor);
  }
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

async function runWriteStream() {
  if (state.dirty) {
    try {
      await saveDraft();
    } catch {
      return;
    }
  }
  const controller = new AbortController();
  state.writeController = controller;
  $('#btn-cancel').classList.remove('hidden');
  updateSave('生成中…');
  $('#draft').value = '';
  try {
    const response = await fetch(`/api/chapters/${state.current}/write/stream`, {
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
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.type === 'delta') {
          $('#draft').value += payload.delta;
          updateWords();
          $('#draft').scrollTop = $('#draft').scrollHeight;
        } else if (payload.type === 'error') {
          failed = payload;
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
    if (!confirm(`确认定稿第 ${state.current} 章？\n草稿 ${state.detail.hash.slice(0, 16)}`)) return;
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

function locateQuote(quote) {
  const editor = $('#draft');
  const index = editor.value.indexOf(quote);
  if (index < 0) {
    toast('当前草稿中找不到该引文', true);
    return;
  }
  editor.focus();
  editor.setSelectionRange(index, index + quote.length);
  const lineHeight = 30;
  editor.scrollTop = Math.max(0, editor.value.slice(0, index).split('\n').length * lineHeight - 120);
}

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
    state.tab = 'revisions';
    $$('#tabs button').forEach(node => node.classList.toggle('active', node.dataset.tab === 'revisions'));
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

function showDiff(revisionId) {
  const revision = state.detail.revisions.find(item => item.revisionId === revisionId);
  if (!revision) return;
  const before = new Map((revision.baseParagraphs || []).map(item => [item.paragraphId, item.text]));
  const body = revision.paragraphs.map(item => `
    <div class="section-label">${escapeHtml(item.paragraphId)}</div>
    <pre>- ${escapeHtml(before.get(item.paragraphId) || '')}\n+ ${escapeHtml(item.text)}</pre>
  `).join('');
  showModal('修订 diff', body, [{ label: '关闭', action: closeModal }]);
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
        baseDraftHash: state.detail.hash,
        selectedText,
        occurrence,
        operation,
        ...(instruction ? { instruction } : {}),
      },
    });
    const candidate = payload.candidate;
    state.detail.revisions.unshift(candidate);
    showSelectionCandidate(candidate);
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

function bind() {
  $('#draft').addEventListener('select', updateSelectionTools);
  $('#draft').addEventListener('keyup', updateSelectionTools);
  $('#draft').addEventListener('mouseup', updateSelectionTools);
  $('#draft').addEventListener('input', () => $('#selection-tools').classList.add('hidden'));
  $$('[data-selection-op]').forEach(node => node.addEventListener('click', () => createSelectionRevision(node.dataset.selectionOp)));
  $('#draft').addEventListener('input', () => {
    state.dirty = true;
    updateWords();
    updateSave('未保存');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveDraft(), 900);
  });
  $$('#stagebar button[data-stage]').forEach(node => node.addEventListener('click', () => runStage(node.dataset.stage)));
  $('#btn-cancel').addEventListener('click', () => state.writeController?.abort());
  $('#btn-refresh').addEventListener('click', () => refresh().catch(error => toast(error.message, true)));
  $('#btn-deconstruct').addEventListener('click', showDeconstruct);
  $('#btn-doctor').addEventListener('click', showDoctor);
  $('#btn-export').addEventListener('click', showExport);
  $('#btn-search').addEventListener('click', openSearch);
  $('#btn-eval').addEventListener('click', showEvalSessions);
  $('#eval-close').addEventListener('click', () => $('#eval-view').classList.add('hidden'));
  $('#eval-report').addEventListener('click', () => showEvalReport().catch(error => toast(error.message, true)));
  $$('#eval-view [data-eval-winner]').forEach(node => node.addEventListener('click', () => submitEvalScore(node.dataset.evalWinner)));
  $$('#eval-view [data-eval-stop]').forEach(node => node.addEventListener('click', () => markEvalStop(node.dataset.evalStop)));
  $('#drawer-close').addEventListener('click', () => $('#drawer').classList.add('hidden'));
  $('#modal-close').addEventListener('click', closeModal);
  $('#search-form').addEventListener('submit', event => { event.preventDefault(); runSearch().catch(error => toast(error.message, true)); });
  $$('#tabs button').forEach(node => node.addEventListener('click', () => {
    state.tab = node.dataset.tab;
    state.preferences.tab = state.tab;
    $$('#tabs button').forEach(item => item.classList.toggle('active', item === node));
    persistPreferences();
    renderInspector().catch(error => toast(error.message, true));
  }));
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveDraft().catch(error => toast(error.message, true));
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
    if (event.key === 'Escape') { closeModal(); $('#drawer').classList.add('hidden'); }
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
