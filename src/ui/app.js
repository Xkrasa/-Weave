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
  if (!state.current && state.chapters.length) state.current = state.chapters[0].chapter;
  renderShell();
  if (state.current) await openChapter(state.current, true);
}

async function openChapter(chapter, silent = false) {
  if (!silent && state.dirty && !confirm('当前草稿还有未保存修改，切换章节会丢失。继续？')) return;
  state.current = chapter;
  state.detail = await api(`/api/chapters/${chapter}`);
  const detail = state.detail;
  const contract = detail.contract;
  $('#chapter-eyebrow').textContent = `第 ${chapter} 章 · ${detail.stages.review?.passed ? '审查通过' : detail.stages.review ? '存在意见' : '未审查'}`;
  $('#chapter-title').textContent = contract?.title || `第 ${chapter} 章`;
  $('#draft').value = detail.draft || '';
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
  ].map(text => `<span>${text}</span>`).join('');
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
          ${finding.quote ? `<div class="quote">“${escapeHtml(finding.quote)}”</div>` : ''}
          ${finding.waiveReason ? `<p class="small">豁免：${escapeHtml(finding.waiveReason)}</p>` : ''}
          <div class="finding-actions">
            ${finding.severity === 'warning' && finding.status !== 'waived' ? `<button data-waive="${escapeHtml(finding.findingId)}">豁免</button>` : ''}
            ${finding.severity === 'blocking' && ['open', 'planned'].includes(finding.status) ? `<button data-revise="${escapeHtml(finding.findingId)}">发起修订</button>` : ''}
            ${finding.severity !== 'blocking' ? `<button data-ignore="${escapeHtml(finding.findingId)}">忽略</button>` : ''}
          </div>
        </div>
      `).join('')
      : `<div class="empty">${review ? '审查通过，没有 finding。' : '尚未运行审查。'}</div>`;
    $$('#inspector-body [data-waive]').forEach(node => node.addEventListener('click', () => waiveFinding(node.dataset.waive)));
    $$('#inspector-body [data-revise]').forEach(node => node.addEventListener('click', () => reviseFinding(node.dataset.revise)));
    $$('#inspector-body [data-ignore]').forEach(node => node.addEventListener('click', () => ignoreFinding(node.dataset.ignore)));
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
      : '<div class="empty">还没有修订候选。blocking finding 可以在“意见”里发起修订。</div>';
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
  }
}

async function runStage(action) {
  if (!state.current) return;
  if (['amend', 'finalize', 'write'].includes(action) && !confirm(`确认执行 ${action}？`)) return;
  if (state.dirty) {
    try {
      await saveDraft();
    } catch {
      return;
    }
  }
  const labels = {
    'contract-check': '合同检查', check: '内容检查', extract: '抽取', audit: '审计',
    review: '审查', recheck: '复检', amend: '重开草稿', finalize: '定稿', write: '生成',
  };
  updateSave(`${labels[action] || action}中…`);
  try {
    const path = action === 'contract-check'
      ? `/api/chapters/${state.current}/contract-check`
      : action === 'write'
        ? `/api/chapters/${state.current}/write`
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

function bind() {
  $('#draft').addEventListener('input', () => {
    state.dirty = true;
    updateWords();
    updateSave('未保存');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveDraft(), 900);
  });
  $$('#stagebar button').forEach(node => node.addEventListener('click', () => runStage(node.dataset.stage)));
  $('#btn-refresh').addEventListener('click', () => refresh().catch(error => toast(error.message, true)));
  $('#btn-deconstruct').addEventListener('click', showDeconstruct);
  $('#btn-doctor').addEventListener('click', showDoctor);
  $('#btn-export').addEventListener('click', showExport);
  $('#btn-search').addEventListener('click', openSearch);
  $('#drawer-close').addEventListener('click', () => $('#drawer').classList.add('hidden'));
  $('#modal-close').addEventListener('click', closeModal);
  $('#search-form').addEventListener('submit', event => { event.preventDefault(); runSearch().catch(error => toast(error.message, true)); });
  $$('#tabs button').forEach(node => node.addEventListener('click', () => {
    state.tab = node.dataset.tab;
    $$('#tabs button').forEach(item => item.classList.toggle('active', item === node));
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

async function boot() {
  const bootstrap = await api('/api/bootstrap');
  state.token = bootstrap.token;
  state.status = bootstrap.status;
  bind();
  await refresh();
}

boot().catch(error => {
  document.body.innerHTML = `<pre style="color:#e7a096;padding:24px">工作台启动失败\n${escapeHtml(error.message)}</pre>`;
});
