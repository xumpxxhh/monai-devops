/* MONAI DevOps 控制台原型 · 共享外壳注入 + 轻量演示交互 */

const NAV = [
  { id: 'dashboard', label: '概览',      icon: 'fa-gauge-high',      href: 'dashboard.html' },
  { id: 'workflows', label: '工作流',    icon: 'fa-diagram-project', href: 'workflows.html' },
  { id: 'runs',      label: '运行',      icon: 'fa-play',            href: 'runs.html' },
  { id: 'plugins',   label: '插件',      icon: 'fa-puzzle-piece',    href: 'plugins.html' },
  { id: 'resources', label: '资源与调度', icon: 'fa-server',          href: 'resources.html' },
];

// 侧边栏「最近运行」快捷区(从任意页一键回到正在盯的运行)
const RECENT_RUNS = [
  { label: 'Build & Deploy', short: 'a1b2c3', status: 'running', href: 'run-detail.html' },
  { label: 'Demo Pipeline',  short: '550e84', status: 'completed', href: 'run-detail.html' },
  { label: 'Nightly E2E',    short: '9f1a2b', status: 'skipped',  href: 'run-detail.html' },
  { label: 'Build & Deploy', short: '77c0e9', status: 'failed',   href: 'run-detail.html' },
];

const STATUS_DOT = {
  running:   'text-running live-dot',
  completed: 'text-completed',
  failed:    'text-failed',
  skipped:   'text-skipped',
  queued:    'text-queued',
};

function renderSidebar(active) {
  const items = NAV.map((n) => {
    const on = n.id === active;
    const cls = on
      ? 'bg-brand-soft text-brand font-medium'
      : 'text-muted hover:bg-raised hover:text-ink';
    return `<a href="${n.href}" class="flex items-center gap-3 px-3 py-2 rounded-ctrl text-sm transition-colors ${cls}">
      <i class="fa-solid ${n.icon} w-4 text-center"></i> ${n.label}
    </a>`;
  }).join('');

  const recent = RECENT_RUNS.map((r) => `
    <a href="${r.href}" class="group flex items-center gap-2 px-3 py-1.5 rounded-ctrl text-xs text-muted hover:bg-raised hover:text-ink transition-colors">
      <i class="fa-solid fa-circle text-[7px] ${STATUS_DOT[r.status] || 'text-muted'}"></i>
      <span class="truncate flex-1">${r.label}</span>
      <span class="font-mono text-faint group-hover:text-muted">#${r.short}</span>
    </a>`).join('');

  return `
  <aside class="w-60 shrink-0 bg-surface border-r border-line flex flex-col">
    <a href="index.html" class="h-14 flex items-center gap-2.5 px-5 border-b border-line">
      <span class="grid place-items-center w-7 h-7 rounded-lg bg-brand/20 text-brand"><i class="fa-solid fa-diagram-project"></i></span>
      <span class="font-semibold tracking-tight">MONAI <span class="text-brand">DevOps</span></span>
    </a>
    <nav class="p-3 space-y-1">${items}</nav>
    <div class="mx-3 my-1 border-t border-line-soft"></div>
    <div class="px-3 pt-1 pb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-faint">
      <i class="fa-regular fa-clock"></i> 最近运行
    </div>
    <div class="px-2 space-y-0.5 overflow-auto">${recent}</div>
    <div class="mt-auto p-3 text-[11px] text-faint border-t border-line-soft">
      v0.1 · 原型 demo
    </div>
  </aside>`;
}

const WS_STATES = [
  { key: 'connected',  label: '已连接 ws', dot: 'bg-completed live-dot', text: 'text-completed' },
  { key: 'reconnect',  label: '重连中…',   dot: 'bg-queued live-dot',    text: 'text-queued' },
  { key: 'down',       label: '连接断开',   dot: 'bg-failed',             text: 'text-failed' },
];
let wsIdx = 0;

function renderTopbar(crumb) {
  return `
  <header class="h-14 shrink-0 bg-surface/80 backdrop-blur border-b border-line flex items-center justify-between px-6">
    <div class="text-sm text-muted flex items-center gap-2">${crumb || ''}</div>
    <div class="flex items-center gap-4">
      <span class="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted px-2.5 py-1 rounded-pill bg-raised border border-line">
        <i class="fa-solid fa-cube text-faint"></i> env: <span class="font-mono text-ink">local</span>
      </span>
      <button id="ws-pill" onclick="cycleWs()" title="点击切换连接状态(演示)"
        class="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-pill bg-raised border border-line hover:border-brand transition-colors">
        <span id="ws-dot" class="w-2 h-2 rounded-full bg-completed live-dot"></span>
        <span id="ws-label" class="font-medium text-completed">已连接 ws</span>
      </button>
      <a href="workflow-editor.html" class="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover transition-colors">
        <i class="fa-solid fa-plus"></i> 新建工作流
      </a>
      <img src="https://i.pravatar.cc/72?img=13" alt="当前用户头像" class="w-8 h-8 rounded-full object-cover ring-1 ring-line" />
    </div>
  </header>`;
}

function cycleWs() {
  wsIdx = (wsIdx + 1) % WS_STATES.length;
  const s = WS_STATES[wsIdx];
  const dot = document.getElementById('ws-dot');
  const label = document.getElementById('ws-label');
  if (!dot || !label) return;
  dot.className = 'w-2 h-2 rounded-full ' + s.dot;
  label.className = 'font-medium ' + s.text;
  label.textContent = s.label;
  if (s.key === 'reconnect') toast('WebSocket 重连中,实时数据暂停刷新');
  if (s.key === 'down') toast('WebSocket 已断开,运行详情将置为只读');
  if (s.key === 'connected') toast('WebSocket 已连接,恢复实时刷新');
  // 广播给页面(如运行详情页据此置只读)
  document.dispatchEvent(new CustomEvent('ws-change', { detail: s }));
}

function mountShell() {
  const page = document.body.dataset.page;
  if (!page) return; // 编排器 / 运行详情等自定义头部页面不注入
  const side = document.getElementById('side-nav');
  const top = document.getElementById('top-bar');
  if (side) side.outerHTML = renderSidebar(page);
  if (top) top.outerHTML = renderTopbar(document.body.dataset.crumb || '');
}

/* ── 通用交互 ── */
function openModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }

function toast(text, kind) {
  const colors = { ok: 'border-completed/50', err: 'border-failed/50', warn: 'border-queued/50' };
  const t = document.createElement('div');
  t.className = `toast-in fixed top-5 left-1/2 z-[80] -translate-x-1/2 bg-raised text-ink text-sm px-4 py-2.5 rounded-ctrl shadow-pop border ${colors[kind] || 'border-line'}`;
  t.innerHTML = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function confirmDanger(msg, onOk) { if (window.confirm(msg)) onOk && onOk(); }

function copyText(text, label) {
  const done = () => toast(`<i class="fa-solid fa-check text-completed mr-1"></i> 已复制 ${label || ''}`, 'ok');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(done);
  } else { done(); }
}

// tab 切换:按钮带 data-tab 指向同组 [data-pane]
function switchTab(btn, group) {
  document.querySelectorAll(`[data-tabgroup="${group}"]`).forEach((b) => {
    b.classList.toggle('tab-active', b === btn);
  });
}

document.addEventListener('DOMContentLoaded', mountShell);
