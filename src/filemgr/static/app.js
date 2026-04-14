'use strict';

/* ================================================================
 * 工具
 * ================================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
};
const svgNS = 'http://www.w3.org/2000/svg';
function icon(name, extraClass = '') {
  const s = document.createElementNS(svgNS, 'svg');
  s.setAttribute('class', 'icon ' + extraClass);
  const u = document.createElementNS(svgNS, 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}

const fmtSize = (n) => {
  if (n == null || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1, v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
};
const fmtSpeed = (bps) => fmtSize(bps) + '/s';
const fmtETA = (sec) => {
  if (!isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.ceil(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec/60)}m${Math.ceil(sec%60)}s`;
  return `${Math.floor(sec/3600)}h${Math.floor((sec%3600)/60)}m`;
};
const fmtTime = (ts) => {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const joinPath = (...parts) => {
  const all = parts.flatMap(p => (p || '').split('/')).filter(Boolean);
  return '/' + all.join('/');
};
const basename = (p) => (p.split('/').filter(Boolean).pop() || '');
const parentPath = (p) => {
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
};

async function api(path, opts = {}) {
  const headers = opts.headers ? { ...opts.headers } : {};
  if (opts.body && !headers['Content-Type'] && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    if (typeof opts.body === 'object') opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers });
  if (res.status === 401) {
    resetUserState();
    renderApp();
    throw new Error(t('login.error.generic'));
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.detail) msg = j.detail; } catch {}
    throw new Error(msg);
  }
  return res;
}
async function apiJSON(path, opts) {
  return await (await api(path, opts)).json();
}

/* ================================================================
 * Toast / Modal
 * ================================================================ */
function toast(msg, kind = '', options = {}) {
  const t = el('div', { class: `toast ${kind}` });
  const iconName = kind === 'ok' ? 'check' : kind === 'err' ? 'warn' : kind === 'warn' ? 'warn' : null;
  if (iconName) t.append(icon(iconName, 'icon-sm'));
  t.append(el('span', { text: msg, style: 'flex:1;min-width:0' }));
  const lifetime = options.lifetime || (options.action ? 7000 : 3000);
  let removed = false;
  const remove = () => {
    if (removed) return; removed = true;
    t.style.opacity = '0'; t.style.transition = 'opacity .2s';
    setTimeout(() => t.remove(), 250);
  };
  if (options.action) {
    const btn = el('button', {
      class: 'toast-action',
      text: options.action.label,
      onclick: async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        try { await options.action.onclick(); } catch (e) { /* 上层已 toast 报错 */ }
        remove();
      },
    });
    t.append(btn);
  }
  $('#toasts').append(t);
  if (lifetime > 0) setTimeout(remove, lifetime);
  return { remove };
}

function showModal({ title, titleMeta = '', body, foot, onClose, wide = false }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal' });
  if (wide) modal.style.width = 'min(92vw, 1100px)';
  const close = () => { backdrop.remove(); onClose && onClose(); };
  const closeBtn = el('button', { class: 'close', title: t('preview.close'), 'aria-label': t('preview.close'), onclick: close });
  closeBtn.append(icon('close'));

  const head = el('div', { class: 'modal-head' },
    el('h3', { text: title }),
    titleMeta ? el('span', { class: 'head-meta', text: titleMeta }) : null,
    closeBtn,
  );
  modal.append(
    head,
    el('div', { class: 'modal-body' }, body),
    foot ? el('div', { class: 'modal-foot' }, ...foot) : null,
  );
  backdrop.append(modal);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
  const escH = (ev) => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', escH); } };
  document.addEventListener('keydown', escH);
  $('#modal-root').append(backdrop);
  return { close, modal, head };
}

function confirmDialog(title, message) {
  return new Promise((resolve) => {
    let decided = false;
    const ok = el('button', { class: 'danger',
      onclick: () => { decided = true; m.close(); resolve(true); } },
      icon('trash'), el('span', { text: t('dialog.confirm.deleteBtn') }));
    const cancel = el('button', { text: t('dialog.confirm.cancel'),
      onclick: () => { decided = true; m.close(); resolve(false); } });
    const m = showModal({ title, body: el('p', { text: message }), foot: [cancel, ok],
      onClose: () => { if (!decided) resolve(false); } });
  });
}

function promptDialog(title, label, initial = '') {
  return new Promise((resolve) => {
    let decided = false;
    const input = el('input', { type: 'text', value: initial });
    const ok = el('button', { class: 'primary', text: t('dialog.confirm.ok'),
      onclick: () => { decided = true; m.close(); resolve(input.value); } });
    const cancel = el('button', { text: t('dialog.confirm.cancel'),
      onclick: () => { decided = true; m.close(); resolve(null); } });
    const body = el('div',
      el('label', { text: label, style: 'display:block;margin-bottom:6px;color:var(--text-dim);font-size:12px' }),
      input,
    );
    const m = showModal({ title, body, foot: [cancel, ok],
      onClose: () => { if (!decided) resolve(null); } });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { decided = true; m.close(); resolve(input.value); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

/* ================================================================
 * 状态
 * ================================================================ */
const state = {
  user: null,
  home: null,
  cwd: '/',
  items: [],
  selected: new Set(),
  dirsizeCache: new Map(),
  sortKey: 'name',    // 'name' | 'size' | 'mtime'
  sortDir: 'asc',     // 'asc' | 'desc'
  search: {
    q: '',
    mode: 'off',      // 'off' | 'local' | 'global'
    results: [],
    truncated: false,
    loading: false,
  },
};

const escapeHtml = (s) => s.replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const rowPath = (item) => item._absPath || joinPath(state.cwd, item.name);

/* VS Code 风格子序列模糊匹配；返回 {score, positions} 或 null。
 * 行首 / 分隔符后 / CamelCase 边界命中加分；连续命中加分、跳字符惩罚；短名加分。*/
const _FM_BOUNDARY = '._- /';
function fuzzyMatch(query, name) {
  if (!query) return null;
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  for (let i = 0; i < q.length; i++) {
    if (n.indexOf(q[i]) < 0) return null;  // 快速拒绝
  }
  const positions = [];
  let qi = 0, prev = -2, score = 0;
  for (let i = 0, nl = n.length; i < nl && qi < q.length; i++) {
    if (n[i] !== q[qi]) continue;
    if (i === 0) score += 14;
    else if (_FM_BOUNDARY.includes(n[i - 1])) score += 9;
    else {
      const dn = name[i - 1], up = name[i];
      if (dn && dn === dn.toLowerCase() && up === up.toUpperCase() && up !== up.toLowerCase()) {
        score += 7;
      }
    }
    if (prev >= 0) {
      if (i === prev + 1) score += 10;
      else score -= 3;
    }
    positions.push(i);
    prev = i;
    qi++;
  }
  if (qi < q.length) return null;
  score -= Math.floor(name.length / 10);
  return { score, positions };
}

function renderNameHighlighted(name, positions) {
  if (!positions || !positions.length) return el('span', { text: name });
  const span = el('span');
  const set = new Set(positions);
  let buf = '';
  const flush = () => { if (buf) { span.append(document.createTextNode(buf)); buf = ''; } };
  for (let i = 0; i < name.length; i++) {
    if (set.has(i)) { flush(); span.append(el('mark', { class: 'match', text: name[i] })); }
    else buf += name[i];
  }
  flush();
  return span;
}

/* ================================================================
 * 语言切换
 * ================================================================ */
function _updateLangButtons() {
  // 按钮 label：当前是中文就显示 "EN"（按下后切到英文），反之 "中"
  const next = (typeof getLang === 'function' && getLang() === 'en') ? '中' : 'EN';
  for (const id of ['lang-label', 'login-lang-label']) {
    const el_ = document.getElementById(id);
    if (el_) el_.textContent = next;
  }
}
function _toggleLang() {
  const cur = (typeof getLang === 'function') ? getLang() : 'zh';
  setLang(cur === 'en' ? 'zh' : 'en');
}
// 应用首次翻译（i18n.js 已经设了 currentLang，DOM 此时已 ready）
applyStaticTranslations();
_updateLangButtons();

document.getElementById('btn-lang')?.addEventListener('click', _toggleLang);
document.getElementById('login-lang-toggle')?.addEventListener('click', _toggleLang);

window.addEventListener('fmgr:lang-change', () => {
  _updateLangButtons();
  // 重新渲染所有动态 UI（仅在已登录态有意义）
  if (state && state.user) {
    renderBreadcrumb();
    renderRows();
    updateStatus();
    updateToolbar();
    if (_lastStatsData) renderStats(_lastStatsData);
    if (typeof applyTheme === 'function') applyTheme(document.documentElement.dataset.theme || null);
  }
});

/* ================================================================
 * 主题（暗色模式）
 * ================================================================ */
const THEME_KEY = 'fmgr.theme';
function currentThemeIsDark() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark') return true;
  if (explicit === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const btn = $('#btn-theme');
  if (btn) {
    const dark = currentThemeIsDark();
    const useEl = btn.querySelector('use');
    if (useEl) useEl.setAttribute('href', dark ? '#i-sun' : '#i-moon');
    const lbl = dark ? t('topbar.theme.toLight') : t('topbar.theme.toDark');
    btn.setAttribute('aria-label', lbl);
    btn.setAttribute('title', lbl);
  }
}
(function initTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    applyTheme(saved);  // 没保存过就跟随系统
  } catch { applyTheme(null); }
  // 系统主题变化时，如果用户没手动选过，同步图标
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!localStorage.getItem(THEME_KEY)) applyTheme(null);
    });
  } catch {}
})();
$('#btn-theme').addEventListener('click', () => {
  const dark = currentThemeIsDark();
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
});

/* ================================================================
 * URL 同步（hash 路由）
 * - #/path/to/dir                       只有 cwd
 * - #/path/to/dir?q=QUERY&mode=global   带搜索
 * 刷新页面/分享链接都可以回到原视图。
 * ================================================================ */
let _urlSyncSuspend = false;
function currentHash() {
  const p = state.cwd === '/' ? '/' : state.cwd;
  const params = [];
  if (state.search.q) {
    params.push('q=' + encodeURIComponent(state.search.q));
    if (state.search.mode === 'global') params.push('mode=global');
  }
  return '#' + p + (params.length ? '?' + params.join('&') : '');
}
function pushStateFromState(replace = false) {
  if (_urlSyncSuspend) return;
  const h = currentHash();
  if (location.hash === h) return;
  try {
    if (replace) history.replaceState(null, '', h);
    else history.pushState(null, '', h);
  } catch {}
}
function parseHash() {
  const raw = decodeURIComponent(location.hash.slice(1) || '/');
  const qi = raw.indexOf('?');
  let path = qi >= 0 ? raw.slice(0, qi) : raw;
  const params = qi >= 0 ? new URLSearchParams(raw.slice(qi + 1)) : new URLSearchParams();
  if (!path.startsWith('/')) path = '/' + path;
  return {
    path: path || '/',
    q: params.get('q') || '',
    mode: params.get('mode') || (params.get('q') ? 'local' : 'off'),
  };
}
async function applyHashToState() {
  _urlSyncSuspend = true;
  try {
    const h = parseHash();
    if (h.q && h.mode === 'global') {
      // 先到父目录环境，再恢复全局搜索
      state.cwd = h.path || '/';
      await listDir(state.cwd);
      searchInput.value = h.q;
      state.search.q = h.q;
      searchClearBtn.classList.remove('hidden');
      await runGlobalSearch();
    } else if (h.q) {
      state.cwd = h.path || '/';
      await listDir(state.cwd);
      searchInput.value = h.q;
      state.search.q = h.q;
      state.search.mode = 'local';
      searchClearBtn.classList.remove('hidden');
      renderRows();
    } else {
      if (state.search.mode !== 'off') exitSearch(true);
      await listDir(h.path || '/');
    }
  } finally {
    _urlSyncSuspend = false;
  }
}
window.addEventListener('popstate', () => {
  if (state.user) applyHashToState();
});

/* ================================================================
 * 登录
 * ================================================================ */
$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const user = $('#li-user').value.trim();
  const password = $('#li-pwd').value;
  const errBox = $('#login-error');
  errBox.classList.add('hidden');
  $('#login-btn').disabled = true;
  try {
    const data = await apiJSON('/api/login', { method: 'POST', body: { user, password } });
    // 切账号时先彻底清掉上一个用户的残留（搜索、stats、传输、modal、URL hash...）
    resetUserState();
    state.user = data.user; state.home = data.home;
    state.cwd = '/';
    renderApp();
    if (location.hash && location.hash.length > 1) {
      applyHashToState();
    } else {
      listDir('/');
    }
    fetchStats(false);
  } catch (e) {
    errBox.textContent = e.message || t('login.error.generic');
    errBox.classList.remove('hidden');
  } finally {
    $('#login-btn').disabled = false;
  }
});

function resetUserState() {
  state.user = null;
  state.home = null;
  state.cwd = '/';
  state.items = [];
  state.selected.clear();
  state.dirsizeCache.clear();
  state.search.q = '';
  state.search.mode = 'off';
  state.search.results = [];
  state.search.truncated = false;
  state.search.loading = false;
  state.sortKey = 'name';
  state.sortDir = 'asc';
  _lastStatsData = null;
  _statsStale = false;
  clearTimeout(_statsRefreshT); _statsRefreshT = 0;

  // UI 清理
  if (searchInput) searchInput.value = '';
  searchClearBtn?.classList.add('hidden');
  searchBanner?.classList.add('hidden');

  // 文件列表
  const tbody = $('#rows');
  if (tbody) tbody.innerHTML = '';
  const bc = $('#breadcrumb');
  if (bc) bc.innerHTML = '';

  // 状态栏
  const sl = $('#status-left'); if (sl) sl.textContent = '—';
  const sr = $('#status-right'); if (sr) sr.textContent = '';
  const si = $('#selection-info'); if (si) si.textContent = '';

  // 统计面板
  for (const id of ['stat-total', 'stat-files', 'stat-dirs', 'stat-recent']) {
    const elx = document.getElementById(id);
    if (elx) elx.textContent = '—';
  }
  for (const id of ['stats-types-list', 'stats-top-files', 'stats-recent-files', 'stats-inline']) {
    const elx = document.getElementById(id);
    if (elx) elx.innerHTML = '';
  }
  const sm = $('#stats-meta');
  if (sm) { sm.textContent = ''; sm.classList.remove('stale'); }
  $('#stats-footnote')?.classList.add('hidden');

  // 传输面板 / 所有打开的 modal / 菜单 backdrop
  if (typeof panelRef !== 'undefined' && panelRef) {
    panelRef.root.remove();
    panelRef = null;
  }
  const mr = $('#modal-root');
  if (mr) mr.innerHTML = '';

  // 虚拟滚动监听
  if (_virtState) {
    _virtState.container.removeEventListener('scroll', _virtState.handler);
    _virtState = null;
  }

  // URL hash（避免下一个账号看到前一个账号的路径）
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
}

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  resetUserState();
  renderApp();
});

function renderApp() {
  if (state.user) {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    $('#who').textContent = state.user;
  } else {
    $('#login-view').classList.remove('hidden');
    $('#app-view').classList.add('hidden');
    $('#li-user').value = ''; $('#li-pwd').value = '';
    $('#login-error').classList.add('hidden');
    setTimeout(() => $('#li-user').focus(), 30);
  }
}

/* ================================================================
 * 文件列表：列出 + 排序 + 渲染
 * ================================================================ */
async function listDir(path) {
  state.cwd = path || '/';
  state.selected.clear();
  $('#rows').innerHTML = `<tr class="loading"><td colspan="5">${escapeHtml(t('list.loading'))}</td></tr>`;
  renderBreadcrumb();
  try {
    const items = await apiJSON(`/api/list?path=${encodeURIComponent(state.cwd)}`);
    state.items = items;
    renderRows();
    fetchPendingDirSizes();
  } catch (e) {
    $('#rows').innerHTML = '';
    $('#rows').append(el('tr', {},
      el('td', { colspan: '5', class: 'dim', style: 'padding:40px;text-align:center' },
        t('list.loadFailed', e.message))));
  }
  updateStatus();
  pushStateFromState();
}

function renderBreadcrumb() {
  const bc = $('#breadcrumb'); bc.innerHTML = '';
  const parts = state.cwd.split('/').filter(Boolean);

  const home = el('a', { onclick: () => listDir('/') },
    icon('home', 'icon-sm'),
    el('span', { text: state.user ? t('breadcrumb.home', state.user) : '~' }));
  bc.append(home);

  let acc = '';
  parts.forEach((p, i) => {
    acc += '/' + p;
    bc.append(el('span', { class: 'sep' }, icon('chevron')));
    const isLast = i === parts.length - 1;
    if (isLast) bc.append(el('span', { class: 'crumb-current', text: p }));
    else bc.append(el('a', { onclick: ((to) => () => listDir(to))(acc) }, el('span', { text: p })));
  });
}

// 生信友好的类别识别：复合扩展（.fastq.gz / .vcf.gz / chrom.sizes / .tar.gz）正确归类
const _BIO_EXTS = {
  sequencing: new Set(['fastq','fq','sam','bam','cram','bai','crai']),
  variants:   new Set(['vcf','bcf','tbi','csi']),
  reference:  new Set(['fa','fasta','fna','faa','ffn','fai',
                       'gff','gff3','gtf',
                       'bed','bedgraph','wig','bigwig','bw','2bit','chain']),
  matrix:     new Set(['h5','h5ad','loom','mtx','h5mu','zarr','anndata']),
  rdata:      new Set(['rds','rdata','rda']),
  notebook:   new Set(['ipynb','qmd','rmd']),
  container:  new Set(['sif','img','sqsh','simg']),
};
const _GENERIC_EXTS = {
  'file-image':   new Set(['png','jpg','jpeg','gif','webp','svg','bmp','tiff','ico','heic','heif','avif']),
  'file-video':   new Set(['mp4','mkv','mov','avi','webm','m4v','flv','wmv','ts']),
  'file-audio':   new Set(['mp3','wav','flac','ogg','m4a','aac','opus','wma']),
  'file-pdf':     new Set(['pdf']),
  'file-archive': new Set(['zip','tar','tgz','tbz','txz','rar','7z','lz4']),
  'file-code':    new Set(['py','js','ts','tsx','jsx','go','rs','c','cpp','h','hpp','sh',
                           'r','java','html','css','sql','rb','php','swift','kt','scala','lua','pl','vb','m','mm',
                           'nf','wdl','smk','snakefile']),
  'file-text':    new Set(['txt','md','log','csv','tsv','json','yaml','yml','xml','ini','conf','toml','rst','org','tex']),
};
const _COMPRESSION_EXTS = new Set(['gz','bgz','bz2','xz','zst']);

function fileTypeClass(item) {
  if (item.type === 'dir') return 'dir';
  let lower = item.name.toLowerCase();
  let comp = '';
  for (const zx of _COMPRESSION_EXTS) {
    if (lower.endsWith('.' + zx)) { comp = zx; lower = lower.slice(0, -(zx.length + 1)); break; }
  }
  if (lower.endsWith('.chrom.sizes')) return 'file-reference';
  if (lower.endsWith('.tar')) return 'file-archive';
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (ext) {
    for (const [cat, set] of Object.entries(_BIO_EXTS)) {
      if (set.has(ext)) return 'file-' + cat;
    }
    for (const [cls, set] of Object.entries(_GENERIC_EXTS)) {
      if (set.has(ext)) return cls;
    }
  }
  if (comp) return 'file-archive';
  return 'file';
}
function iconNameFor(cls) {
  const map = {
    'dir': 'folder',
    'file': 'file',
    'file-image': 'file-image',
    'file-video': 'file-video',
    'file-audio': 'file-audio',
    'file-text': 'file-text',
    'file-code': 'file-code',
    'file-archive': 'file-archive',
    'file-pdf': 'file-pdf',
    'file-sequencing': 'file-dna',
    'file-variants':   'file-dna',
    'file-reference':  'file-dna',
    'file-matrix':     'file-code',
    'file-rdata':      'file-code',
    'file-notebook':   'file-notebook',
    'file-container':  'file-container',
  };
  return map[cls] || 'file';
}

function sortItems(items) {
  // 搜索模式：按模糊匹配分数降序，不再 folders-first（相关性压倒一切）
  if (state.search.mode !== 'off' && items.length && items[0]._fuzzy) {
    return [...items].sort((a, b) => {
      const d = (b._fuzzy?.score ?? 0) - (a._fuzzy?.score ?? 0);
      return d !== 0 ? d : a.name.length - b.name.length;
    });
  }
  const key = state.sortKey, dir = state.sortDir === 'desc' ? -1 : 1;
  const folderFirst = (a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1);
  const cmp = (a, b) => {
    if (key === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    if (key === 'size') {
      const ca = state.dirsizeCache.get(joinPath(state.cwd, a.name));
      const cb = state.dirsizeCache.get(joinPath(state.cwd, b.name));
      const sa = a.type === 'dir' ? (ca ? ca.size_bytes : -1) : (a.size || 0);
      const sb = b.type === 'dir' ? (cb ? cb.size_bytes : -1) : (b.size || 0);
      return sa - sb;
    }
    if (key === 'mtime') return (a.mtime || 0) - (b.mtime || 0);
    return 0;
  };
  return [...items].sort((a, b) => {
    const ff = folderFirst(a, b);
    if (ff !== 0) return ff;
    return cmp(a, b) * dir;
  });
}

function updateSortHeaders() {
  $$('.filelist th.sortable').forEach((th) => {
    const k = th.dataset.sort;
    th.classList.toggle('sorted', k === state.sortKey);
    const mark = th.querySelector('.sort-mark use');
    const ariaSort = k !== state.sortKey ? 'none'
      : state.sortDir === 'asc' ? 'ascending' : 'descending';
    th.setAttribute('aria-sort', ariaSort);
    if (mark) {
      if (k === state.sortKey) {
        mark.setAttribute('href', state.sortDir === 'asc' ? '#i-sort-asc' : '#i-sort-desc');
      } else {
        mark.setAttribute('href', '#i-sort');
      }
    }
  });
}

$$('.filelist th.sortable').forEach((th) => {
  const handle = () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = k; state.sortDir = (k === 'name' ? 'asc' : 'desc'); }
    renderRows();
  };
  th.addEventListener('click', handle);
  th.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handle(); }
  });
});

function getEffectiveItems() {
  const s = state.search;
  if (s.mode === 'global') {
    return s.results.map(m => ({
      name: m.name, type: m.type, size: m.size, mtime: m.mtime,
      _absPath: m.path,
      _fuzzy: { score: m.score ?? 0, positions: m.match || [] },
    }));
  }
  if (s.mode === 'local' && s.q) {
    const out = [];
    for (const i of state.items) {
      const m = fuzzyMatch(s.q, i.name);
      if (m) out.push({ ...i, _fuzzy: m });
    }
    return out;
  }
  return state.items;
}

// 虚拟滚动状态（只在 cwd 下使用，搜索模式不用）
let _virtState = null;
const VIRT_THRESHOLD = 500;
const VIRT_ROW_H = 42;   // 与 .filelist td padding:10 + 行字体高度对齐；全局搜索的双行名会显示不全，搜索模式禁用虚拟滚动

function renderRows() {
  updateSortHeaders();
  const tbody = $('#rows');
  // 清掉可能残留的 scroll listener（切换目录时重建）
  if (_virtState) {
    _virtState.container.removeEventListener('scroll', _virtState.handler);
    _virtState = null;
  }
  const items = sortItems(getEffectiveItems());
  if (!items.length) {
    tbody.innerHTML = '';
    const msg = state.search.mode === 'global'
      ? (state.search.loading ? t('list.searchingDots') : t('list.searchGlobalEmpty', state.search.q))
      : state.search.mode === 'local' && state.search.q
      ? t('list.searchLocalEmpty')
      : t('list.empty');
    tbody.append(el('tr', {}, el('td', { colspan: '5',
      class: 'dim', style: 'padding:40px;text-align:center' }, msg)));
    updateToolbar();
    return;
  }
  const useVirt = state.search.mode === 'off' && items.length > VIRT_THRESHOLD;
  if (useVirt) {
    renderVirtualized(items);
  } else {
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    items.forEach((i) => frag.append(buildRowElement(i)));
    tbody.append(frag);
  }
  updateToolbar();
}

function renderVirtualized(items) {
  const tbody = $('#rows');
  const container = document.querySelector('.main');
  let lastStart = -1, lastEnd = -1, rafPending = false;
  const render = () => {
    const scrollTop = container.scrollTop;
    const vh = container.clientHeight;
    const buffer = 12;
    const start = Math.max(0, Math.floor(scrollTop / VIRT_ROW_H) - buffer);
    const end = Math.min(items.length, Math.ceil((scrollTop + vh) / VIRT_ROW_H) + buffer);
    if (start === lastStart && end === lastEnd) return;
    lastStart = start; lastEnd = end;
    const frag = document.createDocumentFragment();
    const makeSpacer = (h) => {
      const tr = document.createElement('tr');
      tr.className = 'virt-spacer';
      tr.setAttribute('aria-hidden', 'true');
      tr.style.height = h + 'px';
      const td = document.createElement('td');
      td.colSpan = 5; td.style.padding = '0';
      tr.append(td);
      return tr;
    };
    if (start > 0) frag.append(makeSpacer(start * VIRT_ROW_H));
    for (let i = start; i < end; i++) frag.append(buildRowElement(items[i]));
    if (end < items.length) frag.append(makeSpacer((items.length - end) * VIRT_ROW_H));
    tbody.innerHTML = '';
    tbody.append(frag);
  };
  const handler = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  };
  container.addEventListener('scroll', handler, { passive: true });
  _virtState = { container, handler };
  render();
}

function buildRowElement(item) {
    const path = rowPath(item);
    const cls = fileTypeClass(item);
    const checked = state.selected.has(path);

    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = checked;
    checkbox.addEventListener('click', (ev) => ev.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(path); else state.selected.delete(path);
      tr.classList.toggle('selected', checkbox.checked);
      updateToolbar();
    });

    // size cell — 全局搜索结果里，文件夹大小不异步算（成本太高）
    let sizeCell;
    if (item.type === 'dir') {
      const cached = state.dirsizeCache.get(path);
      sizeCell = el('td', { class: 'col-size row-size' });
      if (cached) {
        sizeCell.textContent = cached.truncated
          ? `> ${fmtSize(cached.size_bytes)}` : fmtSize(cached.size_bytes);
        if (cached.truncated) sizeCell.classList.add('truncated');
      } else if (state.search.mode === 'global') {
        sizeCell.innerHTML = '<span class="dim">—</span>';
      } else {
        sizeCell.append(el('span', { class: 'spinner' }));
      }
    } else {
      sizeCell = el('td', { class: 'col-size', text: fmtSize(item.size) });
    }

    const typeIcon = el('span', { class: 'type-icon ' + cls });
    typeIcon.append(icon(iconNameFor(cls)));

    const nameEl = el('span', {
      class: 'name ' + (item.type === 'dir' ? 'dir-link' : 'file-link'),
      title: item.name,
    }, item._fuzzy
      ? renderNameHighlighted(item.name, item._fuzzy.positions)
      : el('span', { text: item.name }));
    if (item.is_symlink) nameEl.append(el('span', { class: 'link-badge', title: 'symlink' }, icon('link', 'icon-sm')));
    nameEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (item.type === 'dir') {
        if (state.search.mode === 'global') exitSearch(false);
        listDir(path);
      } else {
        openPreview(item, path);
      }
    });

    // 全局搜索时：名字下方再显示一行父路径，让用户知道它在哪儿
    const nameCellInner = el('div', { class: 'row-name' }, typeIcon,
      el('div', { style: 'min-width:0;overflow:hidden;flex:1' }, nameEl));
    if (state.search.mode === 'global') {
      const parent = parentPath(path);
      const parentText = parent === '/' ? `~` : `~${parent}`;
      nameCellInner.querySelector('div').append(
        el('div', { class: 'row-subpath', title: parent, text: parentText }));
    }

    const actionsBtn = el('button', { title: t('menu.more'), 'aria-label': t('menu.actionsOf', item.name),
      onclick: (ev) => { ev.stopPropagation(); showRowMenu(ev.currentTarget, item, path); } });
    actionsBtn.append(icon('more'));

    const tr = el('tr', {
      class: checked ? 'selected' : '',
      tabindex: '0',
      'aria-selected': checked ? 'true' : 'false',
    },
      el('td', { class: 'col-check' }, checkbox),
      el('td', { class: 'col-name-cell' }, nameCellInner),
      sizeCell,
      el('td', { class: 'col-mtime', text: fmtTime(item.mtime) }),
      el('td', { class: 'col-actions row-actions' }, actionsBtn),
    );
    const toggleSelect = () => {
      const newState = !state.selected.has(path);
      if (newState) state.selected.add(path); else state.selected.delete(path);
      checkbox.checked = newState;
      tr.classList.toggle('selected', newState);
      tr.setAttribute('aria-selected', newState ? 'true' : 'false');
      updateToolbar();
    };
    const openItem = () => {
      if (item.type === 'dir') {
        if (state.search.mode === 'global') exitSearch(false);
        listDir(path);
      } else {
        openPreview(item, path);
      }
    };
    tr.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'INPUT') return;
      toggleSelect();
    });
    tr.addEventListener('dblclick', openItem);
    tr.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showRowMenu(ev, item, path);
    });
    // 键盘：Enter 打开 | Space 切换选中 | Shift+F10 / ContextMenu 键弹右键菜单
    tr.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); openItem(); }
      else if (ev.key === ' ') { ev.preventDefault(); toggleSelect(); }
      else if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
        ev.preventDefault();
        showRowMenu(tr, item, path);
      }
    });
    return tr;
}

function showRowMenu(anchorOrEvent, item, path, options = {}) {
  // 接受 Element（菜单在其下方弹）或 MouseEvent（菜单在光标位置弹）
  let anchorTop, anchorLeft, positionMode;
  if (anchorOrEvent && typeof anchorOrEvent.clientX === 'number') {
    anchorTop = anchorOrEvent.clientY;
    anchorLeft = anchorOrEvent.clientX;
    positionMode = 'point';
  } else if (anchorOrEvent && typeof anchorOrEvent.getBoundingClientRect === 'function') {
    const rect = anchorOrEvent.getBoundingClientRect();
    anchorTop = rect.bottom + 4;
    anchorLeft = rect.right - 160;
    positionMode = 'anchor';
  } else {
    anchorTop = 100; anchorLeft = 100; positionMode = 'point';
  }

  const backdrop = el('div', { class: 'modal-backdrop', style: { background: 'transparent' } });
  const menu = el('div', { class: 'row-menu' });
  // 先塞一个远离视口但已应用样式的位置，测完尺寸再校正，避免闪现
  menu.style.top = '-9999px';
  menu.style.left = '-9999px';

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', keyH);
  };
  const keyH = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', keyH);

  const addItem = (iconName, text, onclick, danger) => {
    const b = el('button', { class: danger ? 'danger' : '',
      onclick: () => { close(); onclick(); } },
      icon(iconName), el('span', { text }));
    menu.append(b);
  };
  if (item.type === 'file') addItem('eye', t('menu.preview'), () => openPreview(item, path));
  if (item.type === 'file') addItem('download', t('menu.download'), () => downloadWithProgress(item, path));
  addItem('edit', t('menu.rename'), () => renameOne(path));
  menu.append(el('div', { class: 'divider' }));
  addItem('trash', t('menu.delete'),
    () => (options.customDelete ? options.customDelete() : deleteMany([path])),
    true);

  backdrop.append(menu);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
  backdrop.addEventListener('contextmenu', (ev) => { ev.preventDefault(); close(); });
  $('#modal-root').append(backdrop);

  // 插入 DOM 后再量菜单尺寸，贴视口边界做 clamp
  const mw = menu.offsetWidth || 160;
  const mh = menu.offsetHeight || 200;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = anchorTop;
  let left = anchorLeft;
  if (positionMode === 'anchor') left = Math.max(4, left);
  if (left + mw > vw - 4) left = Math.max(4, vw - mw - 4);
  if (top + mh > vh - 4) top = Math.max(4, vh - mh - 4);
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

/* ================================================================
 * 异步算文件夹大小
 * ================================================================ */
async function fetchPendingDirSizes() {
  const cwdSnap = state.cwd;
  const todo = state.items.filter(
    i => i.type === 'dir' && !state.dirsizeCache.has(joinPath(cwdSnap, i.name))
  );
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      const path = joinPath(cwdSnap, item.name);
      try {
        const r = await apiJSON(`/api/dirsize?path=${encodeURIComponent(path)}`);
        state.dirsizeCache.set(path, r);
      } catch {
        state.dirsizeCache.set(path, { size_bytes: 0, file_count: 0, truncated: false, error: true });
      }
      if (state.cwd === cwdSnap) patchSizeCell(path);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  if (state.cwd === cwdSnap && state.sortKey === 'size') renderRows();
  updateStatus();
}
function patchSizeCell(path) {
  const rows = $$('#rows tr');
  rows.forEach((tr) => {
    const nameSpan = tr.querySelector('.row-name .name > span');
    if (!nameSpan) return;
    if (joinPath(state.cwd, nameSpan.textContent) !== path) return;
    const cell = tr.querySelector('.col-size');
    if (!cell) return;
    const r = state.dirsizeCache.get(path);
    if (!r) return;
    cell.innerHTML = '';
    cell.classList.remove('truncated');
    cell.textContent = r.truncated ? `> ${fmtSize(r.size_bytes)}` : fmtSize(r.size_bytes);
    if (r.truncated) cell.classList.add('truncated');
  });
}

/* ================================================================
 * 工具栏动作
 * ================================================================ */
function updateToolbar() {
  const n = state.selected.size;
  $('#selection-info').textContent = n ? t('toolbar.selection', n) : '';
  const has = n > 0;
  $('#btn-bulk-delete').classList.toggle('hidden', !has);
  $('#btn-rename').classList.toggle('hidden', n !== 1);
  $('#btn-download').classList.toggle('hidden', n !== 1);
}
function updateStatus() {
  const files = state.items.filter(i => i.type === 'file').length;
  const dirs = state.items.filter(i => i.type === 'dir').length;
  $('#status-left').textContent = t('status.summary', dirs, files);
  $('#status-right').textContent = state.home ? t('status.root', state.home) : '';
}

$('#btn-refresh').addEventListener('click', () => listDir(state.cwd));
$('#btn-mkdir').addEventListener('click', async () => {
  const name = await promptDialog(t('dialog.mkdir.title'), t('dialog.mkdir.label'));
  if (!name) return;
  if (name.includes('/')) { toast(t('toast.nameHasSlash'), 'err'); return; }
  try {
    await apiJSON('/api/mkdir', { method: 'POST', body: { path: joinPath(state.cwd, name) } });
    toast(t('toast.created'), 'ok');
    scheduleStatsRefresh();
    listDir(state.cwd);
  } catch (e) { toast(e.message, 'err'); }
});
$('#btn-bulk-delete').addEventListener('click', () => deleteMany([...state.selected]));
$('#btn-download').addEventListener('click', () => {
  const p = [...state.selected][0]; if (!p) return;
  const item = state.items.find(i => joinPath(state.cwd, i.name) === p);
  if (item) downloadWithProgress(item, p);
});
$('#btn-rename').addEventListener('click', () => {
  const p = [...state.selected][0]; if (p) renameOne(p);
});
$('#check-all').addEventListener('change', (ev) => {
  state.selected.clear();
  if (ev.target.checked) {
    state.items.forEach(i => state.selected.add(joinPath(state.cwd, i.name)));
  }
  renderRows();
});

async function deleteMany(paths) {
  if (!paths.length) return;
  const msg = paths.length === 1
    ? t('dialog.confirm.deleteOne', basename(paths[0]))
    : t('dialog.confirm.deleteMany', paths.length);
  if (!await confirmDialog(t('dialog.confirm.deleteTitle'), msg)) return;
  const entries = [];  // 用于撤销
  let ok = 0, fail = 0;
  for (const p of paths) {
    try {
      const r = await apiJSON('/api/delete', { method: 'POST', body: { path: p } });
      ok++;
      if (r && r.entry_id) entries.push({ entry_id: r.entry_id, dst: r.original_path || p });
    } catch (e) { fail++; toast(`${basename(p)}: ${e.message}`, 'err'); }
  }
  state.selected.clear();
  state.dirsizeCache.clear();
  listDir(state.cwd);
  if (ok) {
    scheduleStatsRefresh();
    const label = ok === 1 ? t('toast.trashedOne', basename(paths[0]))
                           : (fail ? t('toast.trashedManyPartial', ok, fail)
                                   : t('toast.trashedMany', ok));
    toast(label, fail ? 'warn' : 'ok', {
      action: entries.length ? {
        label: t('toast.undoLabel'),
        onclick: async () => {
          let restored = 0, rfail = 0;
          for (const e of entries) {
            try {
              await apiJSON('/api/trash/restore', { method: 'POST',
                body: { entry_id: e.entry_id, dst: e.dst } });
              restored++;
            } catch (err) { rfail++; toast(err.message, 'err'); }
          }
          if (restored) {
            toast(t('toast.restoredMany', restored), 'ok');
            scheduleStatsRefresh();
            listDir(state.cwd);
          }
        },
      } : null,
    });
  }
}

async function renameOne(path) {
  const oldName = basename(path);
  const newName = await promptDialog(t('dialog.rename.title'), t('dialog.rename.label'), oldName);
  if (!newName || newName === oldName) return;
  if (newName.includes('/')) { toast(t('toast.nameHasSlash'), 'err'); return; }
  try {
    await apiJSON('/api/rename', { method: 'POST',
      body: { src: path, dst: joinPath(parentPath(path), newName) } });
    toast(t('toast.renamed'), 'ok');
    scheduleStatsRefresh();
    listDir(state.cwd);
  } catch (e) { toast(e.message, 'err'); }
}

/* ================================================================
 * 预览
 * ================================================================ */
async function openPreview(item, path) {
  const name = item.name;
  const cls = fileTypeClass(item);
  const body = el('div', { class: 'preview-loading dim',
    style: 'min-width:500px;min-height:120px;display:grid;place-items:center' },
    el('span', { text: t('preview.loading') }));
  const headMeta = el('span', { class: 'head-meta', text: fmtSize(item.size || 0) });
  const downloadBtn = el('button', { class: 'primary',
    onclick: () => downloadWithProgress(item, path) },
    icon('download'), el('span', { text: t('preview.download') }));
  const closeBtn = el('button', { text: t('preview.close'), onclick: () => m.close() });
  const m = showModal({ title: name, body, foot: [el('span', { class: 'spacer' }), closeBtn, downloadBtn] });
  m.head.insertBefore(headMeta, m.head.querySelector('.close'));

  // 对媒体类型按扩展名直接渲染（img/video/audio/iframe），
  // 避免 JSON 探测请求造成同一文件被下载两次。
  const mediaDispatch = {
    'file-image': (b) => renderImagePreview(b, path, headMeta),
    'file-video': (b) => renderVideoPreview(b, path, headMeta),
    'file-audio': (b) => renderAudioPreview(b, path, headMeta),
    'file-pdf':   (b) => renderPdfPreview(b, path),
  };
  const render = mediaDispatch[cls];
  if (render) {
    body.innerHTML = ''; body.className = ''; body.removeAttribute('style');
    render(body);
    return;
  }

  // 文本 / 代码 / 其它：走 JSON 预览或 fallback probe
  try {
    const res = await fetch(`/api/preview?path=${encodeURIComponent(path)}`,
      { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    body.innerHTML = ''; body.className = ''; body.removeAttribute('style');

    if (ct.startsWith('application/json')) {
      const data = await res.json();
      if (data.kind === 'text') renderTextPreview(body, data);
      else renderUnsupported(body, data.mime, data.size);
    } else if (ct.startsWith('image/')) {
      renderImagePreview(body, path, headMeta);
    } else if (ct.startsWith('video/')) {
      renderVideoPreview(body, path, headMeta);
    } else if (ct.startsWith('audio/')) {
      renderAudioPreview(body, path, headMeta);
    } else if (ct === 'application/pdf') {
      renderPdfPreview(body, path);
    } else {
      renderUnsupported(body, ct, item.size);
    }
  } catch (e) {
    body.innerHTML = '';
    renderUnsupported(body, t('toast.previewFailed', e.message), 0);
  }
}

function renderTextPreview(body, data) {
  const wrapBox = el('label', { class: '' },
    el('input', { type: 'checkbox' }),
    el('span', { text: ' ' + t('preview.text.wrap') }));
  const wrapInput = wrapBox.querySelector('input');

  const showLineNoBox = el('label', {},
    el('input', { type: 'checkbox', checked: '' }),
    el('span', { text: ' ' + t('preview.text.lineNo') }));
  const lnInput = showLineNoBox.querySelector('input');

  const pre = el('pre', { class: 'preview-text' });
  function render() {
    pre.classList.toggle('wrap', wrapInput.checked);
    pre.innerHTML = '';
    const lines = data.content.split('\n');
    if (lnInput.checked) {
      lines.forEach((line, i) => {
        const row = document.createElement('div');
        row.style.display = 'block';
        const ln = document.createElement('span');
        ln.className = 'ln'; ln.textContent = String(i + 1);
        const tx = document.createElement('span');
        tx.textContent = line;
        row.append(ln, tx);
        pre.append(row);
      });
    } else {
      pre.textContent = data.content;
    }
  }
  wrapInput.addEventListener('change', render);
  lnInput.addEventListener('change', render);
  render();

  const notes = [];
  if (data.compressed) {
    const innerLabel = data.inner_ext ? ` (.${data.inner_ext})` : '';
    notes.push(data.truncated
      ? t('preview.text.gunzip.truncated', fmtSize(data.content.length), innerLabel)
      : t('preview.text.gunzip.full', innerLabel, fmtSize(data.size)));
  } else if (data.truncated) {
    notes.push(t('preview.text.truncated', fmtSize(data.content.length), fmtSize(data.size)));
  }
  const truncNote = notes.length ? el('span', { class: 'dim', text: notes.join(' · ') }) : null;
  const toolbar = el('div', { class: 'preview-toolbar' }, wrapBox, el('span', { class: 'divider' }), showLineNoBox,
    el('span', { class: 'spacer', style: 'flex:1' }), truncNote);
  body.append(toolbar, pre);
}

function renderImagePreview(body, path, headMeta) {
  const src = `/api/preview?path=${encodeURIComponent(path)}`;
  const img = el('img', { class: 'preview-image', src, alt: basename(path), draggable: 'false' });
  const wrap = el('div', { class: 'preview-image-wrap', tabindex: '0' }, img);

  let scale = 1, tx = 0, ty = 0;
  const MIN_S = 0.1, MAX_S = 20;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const pctLabel = el('span', { class: 'zoom-label', text: '100%' });
  const applyXform = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    pctLabel.textContent = `${Math.round(scale * 100)}%`;
    img.classList.toggle('draggable', scale > 1.001);
  };
  const zoomBy = (factor, cx, cy) => {
    const newS = clamp(scale * factor, MIN_S, MAX_S);
    if (Math.abs(newS - scale) < 1e-4) return;
    const rect = wrap.getBoundingClientRect();
    // scale-about-point：cursor 相对于 wrap 中心的偏移
    const ax = (cx ?? rect.width / 2) - rect.width / 2;
    const ay = (cy ?? rect.height / 2) - rect.height / 2;
    tx = (tx - ax) * (newS / scale) + ax;
    ty = (ty - ay) * (newS / scale) + ay;
    scale = newS;
    applyXform();
  };
  const reset = () => { scale = 1; tx = 0; ty = 0; applyXform(); };
  const zoomTo100 = () => {
    if (!img.clientWidth || !img.naturalWidth) return;
    // 1 CSS px = 1 原生 px 时对应的 scale（基于当前渲染宽度）
    const target = img.naturalWidth / img.clientWidth;
    zoomBy(target / scale);
  };

  img.addEventListener('load', () => {
    headMeta.textContent += ` · ${img.naturalWidth}×${img.naturalHeight}`;
    applyXform();
  });

  // 触控板捏合 = Chrome/Firefox 下的 wheel+ctrlKey；Ctrl+滚轮同上
  wrap.addEventListener('wheel', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    // deltaY 正值 = 向下/缩小；用 exp 映射成平滑乘法因子
    const factor = Math.exp(-ev.deltaY * 0.005);
    zoomBy(factor, cx, cy);
  }, { passive: false });

  // 拖拽平移
  let dragging = false, startX = 0, startY = 0, sTx = 0, sTy = 0;
  img.addEventListener('pointerdown', (ev) => {
    if (scale <= 1.001) return;
    dragging = true;
    img.classList.add('dragging');
    try { img.setPointerCapture(ev.pointerId); } catch {}
    startX = ev.clientX; startY = ev.clientY;
    sTx = tx; sTy = ty;
    ev.preventDefault();
  });
  img.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    tx = sTx + (ev.clientX - startX);
    ty = sTy + (ev.clientY - startY);
    applyXform();
  });
  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    img.classList.remove('dragging');
    try { img.releasePointerCapture(ev.pointerId); } catch {}
  };
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);

  // 双击：适配 <-> 1:1
  img.addEventListener('dblclick', (ev) => {
    ev.preventDefault();
    if (Math.abs(scale - 1) < 0.01) zoomTo100();
    else reset();
  });

  // 键盘：+/- 缩放，0 适配，1 1:1
  const keyH = (ev) => {
    if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
    switch (ev.key) {
      case '+': case '=':
        ev.preventDefault(); zoomBy(1.25); break;
      case '-': case '_':
        ev.preventDefault(); zoomBy(1/1.25); break;
      case '0':
        ev.preventDefault(); reset(); break;
      case '1':
        ev.preventDefault(); zoomTo100(); break;
    }
  };
  document.addEventListener('keydown', keyH);
  // 组件卸载时解绑
  const obs = new MutationObserver(() => {
    if (!document.body.contains(wrap)) {
      document.removeEventListener('keydown', keyH);
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // 工具条
  const btnOut = el('button', { class: 'zoom-btn', title: t('preview.image.zoomOut'),
    onclick: () => zoomBy(1/1.25), text: '−' });
  const btnIn  = el('button', { class: 'zoom-btn', title: t('preview.image.zoomIn'),
    onclick: () => zoomBy(1.25), text: '+' });
  const btnReset = el('button', { class: 'pill', title: t('preview.image.fit'),
    onclick: reset, text: t('preview.image.fitLabel') });
  const btn100 = el('button', { class: 'pill', title: t('preview.image.actual'),
    onclick: zoomTo100, text: '1:1' });
  const toolbar = el('div', { class: 'preview-toolbar' },
    btnOut, pctLabel, btnIn,
    el('span', { class: 'divider' }),
    btnReset, btn100,
    el('span', { style: 'flex:1' }),
    el('span', { class: 'dim', style: 'font-size:11px',
      text: t('preview.image.hint') }),
  );

  body.append(toolbar, wrap);
  setTimeout(() => wrap.focus(), 30);
}

function renderVideoPreview(body, path, headMeta) {
  const src = `/api/preview?path=${encodeURIComponent(path)}`;
  const v = el('video', { class: 'preview-video', controls: '', src, preload: 'metadata' });
  v.addEventListener('loadedmetadata', () => {
    const mins = Math.floor(v.duration / 60);
    const secs = Math.floor(v.duration % 60).toString().padStart(2, '0');
    const meta = [];
    if (v.videoWidth) meta.push(`${v.videoWidth}×${v.videoHeight}`);
    meta.push(`${mins}:${secs}`);
    headMeta.textContent += ' · ' + meta.join(' · ');
  });
  body.append(v);
}

function renderAudioPreview(body, path, headMeta) {
  const src = `/api/preview?path=${encodeURIComponent(path)}`;
  const a = el('audio', { class: 'preview-audio', controls: '', src, preload: 'metadata' });
  a.style.width = '520px';
  a.addEventListener('loadedmetadata', () => {
    const mins = Math.floor(a.duration / 60);
    const secs = Math.floor(a.duration % 60).toString().padStart(2, '0');
    headMeta.textContent += ` · ${mins}:${secs}`;
  });
  body.style.display = 'grid'; body.style.placeItems = 'center'; body.style.padding = '20px';
  body.append(a);
}

function renderPdfPreview(body, path) {
  // 浏览器内置 PDF viewer 本身支持 Ctrl+滚轮/触控板捏合缩放、Ctrl+=/−/0 等；
  // #toolbar=1 激活顶部缩放/翻页工具栏。iframe 加载后把焦点给它，键盘快捷键才生效。
  const src = `/api/preview?path=${encodeURIComponent(path)}#toolbar=1&navpanes=0`;
  const iframe = el('iframe', { class: 'preview-pdf', src });
  iframe.addEventListener('load', () => setTimeout(() => iframe.focus(), 0));
  const hint = el('div', { class: 'preview-toolbar',
    style: 'justify-content:flex-end;color:var(--text-faint);font-size:11px;margin-top:8px' },
    el('span', { text: t('preview.pdf.hint') }));
  body.append(iframe, hint);
}

function renderUnsupported(body, mime, size) {
  const card = el('div', { class: 'preview-unsupported' });
  card.append(icon('file', 'icon-xl'));
  card.append(el('div', { style: 'font-size:14px;color:var(--text)' },
    el('span', { text: t('preview.unsupported.title') })));
  const meta = size
    ? t('preview.unsupported.metaSize', mime || '?', fmtSize(size))
    : t('preview.unsupported.meta', mime || '?');
  card.append(el('div', { class: 'dim', text: meta }));
  body.append(card);
}

/* ================================================================
 * 传输面板（上传/下载通用）
 * ================================================================ */
let panelRef = null;
function ensurePanel() {
  if (panelRef) return panelRef;
  const count = el('span', { class: 'count-chip', text: '0' });
  const title = el('span', { text: t('transfer.title') });
  const hideBtn = el('button', { title: t('transfer.close'), 'aria-label': t('transfer.close'),
    onclick: () => { panelRef.root.remove(); panelRef = null; } });
  hideBtn.append(icon('close', 'icon-sm'));
  const head = el('div', { class: 'transfer-panel-head' },
    icon('upload'), title, count,
    el('span', { class: 'spacer' }),
    hideBtn);
  const list = el('div', { class: 'transfer-list' });
  const root = el('div', { class: 'transfer-panel' }, head, list);
  document.body.append(root);
  panelRef = { root, list, count };
  return panelRef;
}
function bumpPanelCount(delta) {
  if (!panelRef) return;
  const now = parseInt(panelRef.count.textContent || '0', 10) + delta;
  panelRef.count.textContent = String(now);
}

function makeTransferRow({ kind, name, total }) {
  const panel = ensurePanel();
  const dirIcon = el('span', { class: 'dir-icon' }, icon(kind === 'upload' ? 'upload' : 'download'));
  const nameEl = el('span', { class: 'name', title: name, text: name });
  const cancelBtn = el('button', { class: 'cancel', title: t('transfer.cancel'), 'aria-label': t('transfer.cancelOf', name) });
  cancelBtn.append(icon('cancel', 'icon-sm'));
  const barFill = el('div', { class: 'transfer-bar-fill' });
  const bar = el('div', { class: 'transfer-bar' }, barFill);
  const status = el('span', { class: 'status-text', text: t('transfer.waiting') });
  const numbers = el('span', { class: 'numbers', text: `0 / ${fmtSize(total || 0)}` });
  const meta = el('div', { class: 'transfer-meta' }, status, numbers);
  const row = el('div', { class: `transfer-item ${kind}` },
    el('div', { class: 'transfer-row' }, dirIcon, nameEl, cancelBtn),
    bar, meta);
  panel.list.prepend(row);
  bumpPanelCount(1);

  let started = performance.now();
  let lastLoaded = 0, lastT = started;
  let speed = 0;

  function setProgress(loaded, tot) {
    const total = tot || total;
    if (total > 0) {
      const pct = Math.min(100, loaded * 100 / total);
      barFill.style.width = pct.toFixed(1) + '%';
    }
    const now = performance.now();
    if (now - lastT > 400 || loaded === total) {
      speed = (loaded - lastLoaded) * 1000 / Math.max(1, now - lastT);
      lastT = now; lastLoaded = loaded;
    }
    const eta = total > 0 && speed > 0 ? (total - loaded) / speed : Infinity;
    status.textContent = t('transfer.stat', fmtSpeed(speed), fmtETA(eta));
    numbers.textContent = `${fmtSize(loaded)} / ${fmtSize(total || 0)}`;
  }
  function markDone(finalSize) {
    row.classList.add('done'); barFill.style.width = '100%';
    const elapsed = (performance.now() - started) / 1000;
    const avg = finalSize / Math.max(0.001, elapsed);
    status.textContent = t('transfer.done', fmtSpeed(avg));
    numbers.textContent = `${fmtSize(finalSize)} / ${fmtSize(finalSize)}`;
    cancelBtn.remove();
  }
  function markErr(msg) {
    row.classList.add('err');
    status.textContent = msg || t('transfer.err');
    cancelBtn.remove();
  }
  function markCancel() {
    row.classList.add('cancel'); status.textContent = t('transfer.cancelled');
    cancelBtn.remove();
  }
  return { row, cancelBtn, setProgress, markDone, markErr, markCancel };
}

/* ---------- 上传 ---------- */
$('#btn-upload').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  files.forEach(f => uploadOne(f, state.cwd));
});

function uploadOne(file, targetDir) {
  const target = joinPath(targetDir, file.name);
  const tr = makeTransferRow({ kind: 'upload', name: file.name, total: file.size });
  const xhr = new XMLHttpRequest();
  const url = `/api/upload?path=${encodeURIComponent(target)}&overwrite=1`;
  xhr.open('POST', url);
  const form = new FormData();
  form.append('file', file);
  xhr.upload.addEventListener('progress', (ev) => {
    if (ev.lengthComputable) tr.setProgress(ev.loaded, ev.total);
  });
  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      tr.markDone(file.size);
      scheduleStatsRefresh();
      if (targetDir === state.cwd) listDir(state.cwd);
    } else {
      let msg = `${t('transfer.err')} ${xhr.status}`;
      try { const j = JSON.parse(xhr.responseText); if (j.detail) msg = j.detail; } catch {}
      tr.markErr(msg);
      toast(t('toast.uploadFailed', file.name, msg), 'err');
    }
  });
  xhr.addEventListener('error', () => tr.markErr(t('transfer.networkErr')));
  xhr.addEventListener('abort', () => tr.markCancel());
  tr.cancelBtn.addEventListener('click', () => xhr.abort());
  xhr.send(form);
}

/* 拖拽上传 */
const dropZone = $('#drop-zone');
['dragenter', 'dragover'].forEach(t => dropZone.addEventListener(t, (ev) => {
  if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) {
    ev.preventDefault();
    $('#drop-overlay').classList.remove('hidden');
  }
}));
['dragleave', 'drop'].forEach(t => dropZone.addEventListener(t, (ev) => {
  ev.preventDefault();
  if (t === 'dragleave' && ev.relatedTarget && dropZone.contains(ev.relatedTarget)) return;
  $('#drop-overlay').classList.add('hidden');
}));
dropZone.addEventListener('drop', (ev) => {
  const files = [...(ev.dataTransfer?.files || [])];
  files.forEach(f => uploadOne(f, state.cwd));
});

/* ---------- 下载 ---------- */
const DOWNLOAD_XHR_THRESHOLD = 500 * 1024 * 1024;  // 大于 500 MB 走直链（浏览器自带下载器）

function downloadWithProgress(item, path) {
  const name = basename(path);
  const size = item.size || 0;
  if (size > DOWNLOAD_XHR_THRESHOLD) {
    toast(t('toast.downloadBigWarn', fmtSize(size)), 'warn');
    directDownload(path, name);
    return;
  }
  const tr = makeTransferRow({ kind: 'download', name, total: size });
  const url = `/api/download?path=${encodeURIComponent(path)}`;
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  xhr.responseType = 'blob';
  xhr.addEventListener('progress', (ev) => {
    if (ev.lengthComputable) tr.setProgress(ev.loaded, ev.total);
  });
  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      const blob = xhr.response;
      const blobUrl = URL.createObjectURL(blob);
      const a = el('a', { href: blobUrl, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
      tr.markDone(blob.size);
    } else {
      let msg = `${t('transfer.err')} ${xhr.status}`;
      try { const j = JSON.parse(xhr.response || '{}'); if (j.detail) msg = j.detail; } catch {}
      tr.markErr(msg);
      toast(t('toast.uploadFailed', name, msg), 'err');
    }
  });
  xhr.addEventListener('error', () => tr.markErr(t('transfer.networkErr')));
  xhr.addEventListener('abort', () => tr.markCancel());
  tr.cancelBtn.addEventListener('click', () => xhr.abort());
  xhr.send();
}

function directDownload(path, name) {
  const a = el('a', { href: `/api/download?path=${encodeURIComponent(path)}`, download: name });
  document.body.append(a); a.click(); a.remove();
}

/* ================================================================
 * 回收站
 * ================================================================ */
async function openTrashModal() {
  const body = el('div', { style: 'min-width:540px' });
  const statusLine = el('div', { class: 'dim', style: 'font-size:12px;margin-bottom:10px' }, t('preview.loading'));
  const list = el('ul', { class: 'stats-list' });
  body.append(statusLine, list);

  const emptyBtn = el('button', { class: 'danger',
    onclick: async () => {
      if (!await confirmDialog(t('trash.emptyConfirm.title'), t('trash.emptyConfirm.msg'))) return;
      try {
        await apiJSON('/api/trash/purge', { method: 'POST', body: {} });
        toast(t('toast.emptyTrashed'), 'ok');
        scheduleStatsRefresh();
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    } },
    icon('trash'), el('span', { text: t('trash.emptyBtn') }));
  const closeBtn = el('button', { text: t('preview.close'), onclick: () => m.close() });
  const m = showModal({
    title: t('trash.title'),
    body,
    foot: [emptyBtn, el('span', { class: 'spacer' }), closeBtn],
    wide: true,
  });

  async function refresh() {
    statusLine.textContent = t('preview.loading');
    list.innerHTML = '';
    try {
      const data = await apiJSON('/api/trash/list');
      const items = data.items || [];
      const retention = data.retention_days || 3;
      const retentionSec = retention * 86400;
      const summary = items.length ? t('trash.summary', items.length) : t('trash.empty');
      statusLine.innerHTML = '';
      statusLine.append(
        el('span', { text: summary }),
        el('span', { style: 'margin:0 6px;color:var(--border-strong)', text: '·' }),
        el('span', { style: 'color:var(--warn)', text: t('trash.retention', retention) }),
      );
      emptyBtn.disabled = !items.length;
      emptyBtn.style.opacity = items.length ? '1' : '.5';
      const now = Date.now() / 1000;
      items.forEach(it => {
        const name = it.original_name || basename(it.original_path || '');
        const cls = it.is_dir ? 'dir' : fileTypeClass({ name, type: 'file' });
        const iconEl = el('span', { class: 'type-icon ' + cls }, icon(iconNameFor(cls)));
        const nameCol = el('div', { class: 'name-col' },
          el('span', { text: name, title: it.original_path }),
          el('span', { class: 'sub', text: it.original_path || '' }));
        const sizeText = it.is_dir ? t('trash.isDir') : fmtSize(it.size || 0);
        const remain = Math.max(0, retentionSec - (now - (it.deleted_at || 0)));
        const remainLabel = remain <= 0 ? t('trash.remain.imminent')
          : remain < 3600 ? t('trash.remain.minutes', Math.ceil(remain/60))
          : remain < 86400 ? t('trash.remain.hours', Math.floor(remain/3600))
          : t('trash.remain.days', Math.floor(remain/86400), Math.floor((remain%86400)/3600));
        const remainColor = remain < 86400 ? 'var(--warn)' : 'var(--text-faint)';
        const metaEl = el('span', { class: 'meta' },
          el('span', { text: sizeText }),
          el('span', { style: 'margin:0 6px;opacity:.5', text: '·' }),
          el('span', { text: fmtRelTime(it.deleted_at) }),
          el('span', { style: `margin-left:8px;color:${remainColor};font-weight:500`,
            text: remainLabel,
            title: t('trash.willDeleteAt', fmtTime((it.deleted_at||0) + retentionSec)) }),
        );

        const restoreBtn = el('button', {
          class: 'action-btn', title: t('trash.restore'), 'aria-label': t('trash.restoreOf', name),
          style: 'opacity:1',
          onclick: async (ev) => {
            ev.stopPropagation();
            try {
              await apiJSON('/api/trash/restore', { method: 'POST',
                body: { entry_id: it.entry_id, dst: it.original_path } });
              toast(t('trash.restoredOne', name), 'ok');
              scheduleStatsRefresh();
              listDir(state.cwd);
              li.remove();
            } catch (e) {
              // 原位置已占用等情况，让用户选新位置
              const newDst = await promptDialog(t('trash.restore'),
                t('trash.restoreFailed', e.message), it.original_path);
              if (!newDst) return;
              try {
                await apiJSON('/api/trash/restore', { method: 'POST',
                  body: { entry_id: it.entry_id, dst: newDst } });
                toast(t('toast.restoredOne'), 'ok');
                scheduleStatsRefresh();
                listDir(state.cwd);
                li.remove();
              } catch (e2) { toast(e2.message, 'err'); }
            }
          }
        });
        restoreBtn.append(icon('refresh'));
        const purgeBtn = el('button', {
          class: 'action-btn', title: t('trash.purge'), 'aria-label': t('trash.purgeOf', name),
          style: 'opacity:1;color:var(--danger)',
          onclick: async (ev) => {
            ev.stopPropagation();
            if (!await confirmDialog(t('trash.purgeConfirm.title'),
                                     t('trash.purgeConfirm.msg', name))) return;
            try {
              await apiJSON('/api/trash/purge', { method: 'POST',
                body: { entry_id: it.entry_id } });
              toast(t('toast.purgedOne'), 'ok');
              li.remove();
              if (list.children.length === 0) {
                statusLine.textContent = t('trash.empty');
                emptyBtn.disabled = true;
                emptyBtn.style.opacity = '.5';
              }
            } catch (e) { toast(e.message, 'err'); }
          }
        });
        purgeBtn.append(icon('trash'));

        const li = el('li', {
          title: it.original_path, style: 'grid-template-columns: 22px 1fr auto 28px 28px;'
        }, iconEl, nameCol, metaEl, restoreBtn, purgeBtn);
        list.append(li);
      });
    } catch (e) {
      statusLine.textContent = t('list.loadFailed', e.message);
    }
  }
  refresh();
}

$('#btn-trash').addEventListener('click', () => openTrashModal());

/* ================================================================
 * 统计面板
 * ================================================================ */
const STATS_COLLAPSED_KEY = 'fmgr.stats.collapsed';
const TYPE_META = {
  image:    { labelKey: 'type.image',    color: '#2bb673', icon: 'file-image' },
  video:    { labelKey: 'type.video',    color: '#b04dcb', icon: 'file-video' },
  audio:    { labelKey: 'type.audio',    color: '#d99800', icon: 'file-audio' },
  pdf:      { labelKey: 'type.pdf',      color: '#d93e3e', icon: 'file-pdf' },
  archive:  { labelKey: 'type.archive',  color: '#8a6d3b', icon: 'file-archive' },
  code:     { labelKey: 'type.code',     color: '#0a7ea4', icon: 'file-code' },
  document: { labelKey: 'type.document', color: '#3461c1', icon: 'file' },
  text:     { labelKey: 'type.text',     color: '#5a6272', icon: 'file-text' },
  sequencing: { labelKey: 'type.sequencing', color: '#0ea5e9', icon: 'file-dna' },
  variants:   { labelKey: 'type.variants',   color: '#14b8a6', icon: 'file-dna' },
  reference:  { labelKey: 'type.reference',  color: '#6366f1', icon: 'file-dna' },
  matrix:     { labelKey: 'type.matrix',     color: '#d946ef', icon: 'file-code' },
  rdata:      { labelKey: 'type.rdata',      color: '#8b5cf6', icon: 'file-code' },
  notebook:   { labelKey: 'type.notebook',   color: '#f97316', icon: 'file-notebook' },
  container:  { labelKey: 'type.container',  color: '#475569', icon: 'file-container' },
  other:    { labelKey: 'type.other',    color: '#9aa1ad', icon: 'file' },
};
const typeLabel = (cat) => t((TYPE_META[cat] || TYPE_META.other).labelKey);

function fmtNumber(n) {
  if (n >= 10000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
  return String(n);
}
function fmtRelTime(ts) {
  if (!ts) return '';
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return t('time.justNow');
  if (diff < 3600) return t('time.minutesAgo', Math.floor(diff/60));
  if (diff < 86400) return t('time.hoursAgo', Math.floor(diff/3600));
  if (diff < 86400*30) return t('time.daysAgo', Math.floor(diff/86400));
  return fmtTime(ts);
}
function splitSizeValue(bytes) {
  if (!bytes) return { num: '0', unit: 'B' };
  const s = fmtSize(bytes);
  const m = s.match(/^([\d.]+)\s*(.+)$/);
  return m ? { num: m[1], unit: m[2] } : { num: s, unit: '' };
}

let _lastStatsData = null;
function renderStats(data) {
  if (!data || typeof data !== 'object') return;
  _lastStatsData = data;
  const { num, unit } = splitSizeValue(data.total_size || 0);
  $('#stat-total').innerHTML = `${num}<span class="unit">${unit}</span>`;
  $('#stat-files').textContent = fmtNumber(data.file_count || 0);
  $('#stat-dirs').textContent = fmtNumber(data.dir_count || 0);
  $('#stat-recent').textContent = fmtNumber(data.recent_count || 0);

  const typesContainer = $('#stats-types-list');
  typesContainer.innerHTML = '';
  const byType = data.by_type || {};
  const rows = Object.entries(byType)
    .map(([cat, v]) => ({ cat, size: v.size, count: v.count }))
    .filter(r => r.count > 0)
    .sort((a, b) => b.size - a.size);
  const maxSize = rows.length ? rows[0].size || 1 : 1;
  rows.forEach(r => {
    const meta = TYPE_META[r.cat] || TYPE_META.other;
    const pct = Math.max(2, Math.round(r.size * 100 / maxSize));  // min 2% 显示色条
    const labelText = t(meta.labelKey);
    const row = el('div', {
      class: 'type-row',
      title: t('topByType.title', labelText),
      onclick: () => openTopByTypeModal(r.cat),
    },
      el('span', { class: 'type-label' },
        el('span', { class: 'dot', style: { background: meta.color } }),
        el('span', { text: labelText })),
      el('div', { class: 'type-bar' },
        el('div', { class: 'type-bar-fill',
          style: { width: pct + '%', background: meta.color } })),
      el('span', { class: 'type-numbers' },
        el('span', { text: fmtSize(r.size) }),
        el('span', { class: 'count', text: ' · ' + fmtNumber(r.count) })),
    );
    typesContainer.append(row);
  });
  if (!rows.length) typesContainer.append(el('div', { class: 'dim', text: t('stats.types.empty') }));

  const renderList = (ul, items, showTime) => {
    ul.innerHTML = '';
    if (!items || !items.length) {
      ul.append(el('li', { class: 'dim', text: t('stats.list.empty') }));
      return;
    }
    items.forEach(f => {
      const name = basename(f.path);
      const parent = parentPath(f.path);
      const cls = fileTypeClass({ name, type: 'file' });
      const item = { name, type: 'file', size: f.size, mtime: f.mtime };
      const iconEl = el('span', { class: 'type-icon ' + cls }, icon(iconNameFor(cls)));
      const nameCol = el('div', { class: 'name-col' },
        el('span', { text: name, title: f.path }),
        el('span', { class: 'sub', text: parent === '/' ? '~' : `~${parent}` }));
      const meta = el('span', { class: 'meta',
        text: showTime ? fmtRelTime(f.mtime) : fmtSize(f.size),
        title: showTime ? `${fmtTime(f.mtime)} · ${fmtSize(f.size)}` : fmtTime(f.mtime) });
      const actionBtn = el('button', { class: 'action-btn',
        title: t('menu.more'), 'aria-label': t('menu.actionsOf', name),
        onclick: (ev) => {
          ev.stopPropagation();
          showRowMenu(ev.currentTarget, item, f.path, {
            customDelete: () => statsDelete(f, li),
          });
        } });
      actionBtn.append(icon('more'));
      const li = el('li', {
        title: f.path,
        onclick: () => openFileFromStats(f),
      }, iconEl, nameCol, meta, actionBtn);
      li.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        showRowMenu(ev, item, f.path, { customDelete: () => statsDelete(f, li) });
      });
      ul.append(li);
    });
  };
  renderList($('#stats-top-files'), data.top_files, false);
  renderList($('#stats-recent-files'), data.recent_files, true);

  // 「近 N 天修改」label
  const recentLabelEl = $('#stat-recent-label');
  if (recentLabelEl) recentLabelEl.textContent = t('stats.label.recent', data.recent_days || 7);

  const when = data.generated_at ? fmtRelTime(data.generated_at) : '';
  const metaEl = $('#stats-meta');
  metaEl.classList.remove('stale');
  metaEl.textContent = data.scanned
    ? t('stats.meta.when', when, fmtNumber(data.scanned))
    : when;
  _statsStale = false;

  // 折叠时仍能看见的内联摘要
  const inline = $('#stats-inline');
  if (inline) {
    inline.innerHTML = '';
    inline.append(
      el('span', {}, el('strong', { text: fmtSize(data.total_size || 0) }),
        el('span', { text: ' ' + t('stats.inline.used') })),
      el('span', {}, el('strong', { text: fmtNumber(data.file_count || 0) }),
        el('span', { text: ' ' + t('stats.inline.files') })),
      el('span', {}, el('strong', { text: fmtNumber(data.recent_count || 0) }),
        el('span', { text: ' ' + t('stats.inline.recent') })),
    );
  }

  const foot = $('#stats-footnote');
  if (data.truncated) {
    foot.classList.remove('hidden');
    foot.textContent = t('stats.truncated');
  } else {
    foot.classList.add('hidden');
  }
}

function openFileFromStats(f) {
  const item = {
    name: basename(f.path), type: 'file',
    size: f.size, mtime: f.mtime,
  };
  openPreview(item, f.path);
}

async function statsDelete(f, li) {
  const name = basename(f.path);
  if (!await confirmDialog(t('dialog.confirm.deleteTitle'), t('dialog.confirm.deleteOne', name))) return;
  try {
    const r = await apiJSON('/api/delete', { method: 'POST', body: { path: f.path } });
    if (li && li.parentNode) li.remove();
    scheduleStatsRefresh();
    if (state.cwd === parentPath(f.path) || state.cwd === '/' || f.path.startsWith(state.cwd + '/')) {
      listDir(state.cwd);
    }
    toast(t('toast.trashedOne', name), 'ok', {
      action: r && r.entry_id ? {
        label: t('toast.undoLabel'),
        onclick: async () => {
          try {
            await apiJSON('/api/trash/restore', { method: 'POST',
              body: { entry_id: r.entry_id, dst: r.original_path || f.path } });
            toast(t('toast.restoredOne'), 'ok');
            scheduleStatsRefresh();
            if (state.cwd === parentPath(f.path) || state.cwd === '/') listDir(state.cwd);
          } catch (err) { toast(err.message, 'err'); }
        },
      } : null,
    });
  } catch (e) { toast(e.message, 'err'); }
}

let _statsStale = false;
let _statsRefreshT = 0;
function markStatsStale() {
  _statsStale = true;
  const meta = $('#stats-meta');
  if (meta) {
    meta.classList.add('stale');
    meta.textContent = t('stats.stale');
  }
}
// 防抖自动刷新：800ms 内多次变更只最后一次重算；
// 长时间任务（如批量上传）也只在最后一次完成后触发一次。
function scheduleStatsRefresh() {
  markStatsStale();
  clearTimeout(_statsRefreshT);
  _statsRefreshT = setTimeout(() => {
    _statsRefreshT = 0;
    fetchStats(true);
  }, 800);
}

function openTopByTypeModal(category) {
  const meta = TYPE_META[category] || { labelKey: 'type.other', color: '#9aa1ad' };
  const labelText = t(meta.labelKey);
  let cancelled = false;
  let debounceT = 0;
  let activeReqId = 0;

  const numberInput = el('input', { type: 'number', min: '5', max: '100', value: '20',
    style: 'width:60px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:4px;font-variant-numeric:tabular-nums' });
  const slider = el('input', { type: 'range', min: '5', max: '100', step: '5', value: '20',
    style: 'flex:1;max-width:260px' });
  const statusLine = el('div', { class: 'dim',
    style: 'margin:6px 0 10px;font-size:12px' });
  const list = el('ul', { class: 'stats-list', style: 'min-width:520px' });
  const dot = el('span', { style: {
    width: '10px', height: '10px', borderRadius: '50%',
    background: meta.color, display: 'inline-block', marginRight: '6px',
  }});
  const showTopLabel = t('topByType.showTop', '__N__').split('__N__');
  const titleRow = el('div',
    { style: 'display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap' },
    el('label', { style: 'display:inline-flex;align-items:center;gap:6px;font-size:13px' },
      el('span', { text: showTopLabel[0] }), numberInput, el('span', { text: showTopLabel[1] || '' })),
    slider,
  );
  const body = el('div', { style: 'min-width:540px' }, titleRow, statusLine, list);

  const closeBtn = el('button', { text: t('preview.close'), onclick: () => m.close() });
  const m = showModal({
    title: t('topByType.title', labelText),
    body,
    foot: [el('span', { class: 'spacer' }), closeBtn],
    onClose: () => { cancelled = true; },
    wide: true,
  });
  // 在标题左侧色点
  m.head.insertBefore(dot, m.head.querySelector('h3'));

  async function refresh() {
    if (cancelled) return;
    let n = parseInt(numberInput.value, 10);
    if (!Number.isFinite(n)) n = 20;
    n = Math.max(5, Math.min(100, n));
    numberInput.value = n;
    slider.value = n;
    const reqId = ++activeReqId;
    statusLine.textContent = t('topByType.loading', labelText, n);
    list.innerHTML = '';
    try {
      const data = await apiJSON(`/api/top_by_type?cat=${encodeURIComponent(category)}&top=${n}`);
      if (cancelled || reqId !== activeReqId) return;
      const totalShown = data.items.length;
      let line = t('topByType.summary', data.matched || 0, labelText, totalShown);
      if (data.truncated) line += ' · ' + t('topByType.truncated');
      if (data.scanned) line += ' · ' + t('topByType.scanned', fmtNumber(data.scanned));
      statusLine.textContent = line;
      if (!data.items.length) {
        list.append(el('li', { class: 'dim', text: t('topByType.none') }));
        return;
      }
      data.items.forEach(f => {
        const name = basename(f.path);
        const parent = parentPath(f.path);
        const cls = fileTypeClass({ name, type: 'file' });
        const item = { name, type: 'file', size: f.size, mtime: f.mtime };
        const iconEl = el('span', { class: 'type-icon ' + cls }, icon(iconNameFor(cls)));
        const nameCol = el('div', { class: 'name-col' },
          el('span', { text: name, title: f.path }),
          el('span', { class: 'sub', text: parent === '/' ? '~' : `~${parent}` }));
        const metaEl = el('span', { class: 'meta',
          text: `${fmtSize(f.size)} · ${fmtRelTime(f.mtime)}`,
          title: fmtTime(f.mtime) });
        const actionBtn = el('button', { class: 'action-btn',
          title: t('menu.more'), 'aria-label': t('menu.actionsOf', name),
          onclick: (ev) => {
            ev.stopPropagation();
            showRowMenu(ev.currentTarget, item, f.path, {
              customDelete: () => statsDelete(f, li),
            });
          } });
        actionBtn.append(icon('more'));
        const li = el('li', {
          title: f.path,
          onclick: () => openPreview(item, f.path),
        }, iconEl, nameCol, metaEl, actionBtn);
        li.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          showRowMenu(ev, item, f.path, { customDelete: () => statsDelete(f, li) });
        });
        list.append(li);
      });
    } catch (e) {
      if (!cancelled && reqId === activeReqId) {
        statusLine.textContent = t('topByType.loadFailed', e.message);
      }
    }
  }
  const scheduleRefresh = () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(refresh, 300);
  };
  numberInput.addEventListener('input', () => { slider.value = numberInput.value; scheduleRefresh(); });
  slider.addEventListener('input', () => { numberInput.value = slider.value; scheduleRefresh(); });
  numberInput.addEventListener('change', scheduleRefresh);
  refresh();
}

async function fetchStats(force = false) {
  $('#stats-meta').textContent = t('stats.meta.scanning');
  try {
    const data = await apiJSON(`/api/stats${force ? '?refresh=1' : ''}`);
    renderStats(data);
  } catch (e) {
    $('#stats-meta').textContent = t('stats.meta.failed', e.message);
  }
}

$('#stats-toggle').addEventListener('click', () => {
  const panel = $('#stats-panel');
  const collapsed = panel.classList.toggle('collapsed');
  try { localStorage.setItem(STATS_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
});
$('#stats-refresh').addEventListener('click', () => fetchStats(true));

// 初始折叠状态：读 localStorage，默认展开
(function initStatsCollapse() {
  try {
    if (localStorage.getItem(STATS_COLLAPSED_KEY) === '1') {
      $('#stats-panel').classList.add('collapsed');
    }
  } catch {}
})();

/* ================================================================
 * 搜索
 * ================================================================ */
const searchInput = $('#search-input');
const searchClearBtn = $('#search-clear');
const searchBanner = $('#search-banner');

function exitSearch(clearInput = true) {
  if (clearInput) searchInput.value = '';
  state.search.q = '';
  state.search.mode = 'off';
  state.search.results = [];
  state.search.truncated = false;
  state.search.loading = false;
  searchBanner.classList.add('hidden');
  searchClearBtn.classList.add('hidden');
  renderRows();
  pushStateFromState();
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  state.search.q = q;
  searchClearBtn.classList.toggle('hidden', !q);
  if (!q) {
    // 清空 → 退出搜索模式，回到 cwd
    exitSearch(false);
    return;
  }
  // 输入中默认走本地过滤；用户按 Enter 才触发全局
  if (state.search.mode !== 'global') {
    state.search.mode = 'local';
    renderRows();
  }
});
searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); runGlobalSearch(); }
  else if (ev.key === 'Escape') {
    ev.preventDefault();
    exitSearch();
    searchInput.blur();
  }
});
searchClearBtn.addEventListener('click', () => { exitSearch(); searchInput.focus(); });
$('#search-exit').addEventListener('click', () => exitSearch());

async function runGlobalSearch() {
  const q = state.search.q;
  if (!q) return;
  state.search.mode = 'global';
  state.search.loading = true;
  state.selected.clear();
  searchBanner.classList.remove('hidden');
  const bannerText = searchBanner.querySelector('.banner-text');
  const bannerMeta = $('#search-banner-meta');
  bannerText.innerHTML = t('searchBanner.searching', escapeHtml(q));
  bannerMeta.textContent = '';
  $('#rows').innerHTML = `<tr class="loading"><td colspan="5">${escapeHtml(t('list.searchingDots'))}</td></tr>`;
  try {
    const data = await apiJSON(`/api/search?q=${encodeURIComponent(q)}&path=/`);
    state.search.results = data.matches || [];
    state.search.truncated = !!data.truncated;
    const n = state.search.results.length;
    const truncSuffix = data.truncated ? t('searchBanner.truncatedSuffix') : '';
    bannerText.innerHTML = t('searchBanner.found', escapeHtml(q), n, truncSuffix);
    bannerMeta.textContent = data.truncated ? t('searchBanner.truncatedNote') : '';
  } catch (e) {
    state.search.results = [];
    bannerText.textContent = t('searchBanner.failed', e.message);
  } finally {
    state.search.loading = false;
    renderRows();
    pushStateFromState();
  }
}

/* ================================================================
 * 键盘快捷键 & 启动
 * ================================================================ */
document.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
  if (!state.user) return;
  if (ev.key === 'Delete' && state.selected.size) {
    deleteMany([...state.selected]);
  } else if (ev.key === 'F2' && state.selected.size === 1) {
    renameOne([...state.selected][0]);
  } else if (ev.key === '/' || (ev.key === 'f' && (ev.ctrlKey || ev.metaKey))) {
    ev.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (ev.key.toLowerCase() === 'r' && !ev.ctrlKey && !ev.metaKey) {
    listDir(state.cwd);
  } else if (ev.key === 'Backspace' && state.cwd !== '/' && state.search.mode === 'off') {
    listDir(parentPath(state.cwd));
  }
});

(async () => {
  try {
    const me = await apiJSON('/api/whoami');
    state.user = me.user; state.home = me.home;
    renderApp();
    // 如果 URL hash 里有路径/搜索态，按 hash 恢复；否则到根目录
    if (location.hash && location.hash.length > 1) {
      applyHashToState();
    } else {
      listDir('/');
    }
    fetchStats(false);
  } catch {
    state.user = null;
    renderApp();
  }
})();
