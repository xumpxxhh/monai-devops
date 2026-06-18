# 高保真 HTML 原型:脚手架与组件参考

这份参考给出固定技术栈下的**页面骨架、设计 token 注入写法、常用组件的 Tailwind 实现片段、取图与图标用法**。目标是让每个页面快速搭起来、风格统一,不用每页从零拼。**所有具体颜色 / 字号都从你在步骤 3 定的 token 取,下面的值只是示例占位,务必替换成你这套原型的 token。**

## 目录

1. [页面骨架模板](#1-页面骨架模板)
2. [设计 token 注入(tailwind.config)](#2-设计-token-注入tailwindconfig)
3. [共享应用外壳](#3-共享应用外壳)
4. [常用组件片段(Antd 作交互参考,视觉用你的 token)](#4-常用组件片段)
5. [真实图片与图标](#5-真实图片与图标)
6. [轻量交互(原生-js)](#6-轻量交互原生-js)

---

## 1. 页面骨架模板

每个页面都是一个能独立打开的 `.html`。基础骨架:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>页面标题 · 产品名</title>

  <!-- Tailwind Play CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- FontAwesome -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/css/all.min.css" />

  <script>
    // 在此注入这套原型的设计 token(见第 2 节)
    tailwind.config = { /* ... */ };
  </script>
  <style>
    /* 字体栈、滚动条、prefers-reduced-motion 等全局微调放这里 */
    :root { font-family: "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif; }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
  </style>
</head>
<body class="bg-canvas text-ink antialiased">
  <!-- 共享应用外壳(见第 3 节)+ 主内容区 -->
</body>
</html>
```

> 用 Play CDN 时,所有 token 走 `tailwind.config` 注入即可,通常不需要本地 CSS 文件。若页面很多想抽公共部分,可把 `tailwind.config` 与全局 `<style>` 抽到同目录一个 `theme.js` / `theme.css` 并在每页引入,保持一致。

---

## 2. 设计 token 注入(tailwind.config)

把步骤 3 定下的 token 落到这里。**下面是示例,请替换成你这套原型的真实选择**(主色尤其不要无脑用默认蓝)。

```html
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          // —— 以下为示例值,替换成你这套原型的 token ——
          brand:   { DEFAULT: '#3A5BFF', hover: '#2E49D6', soft: '#EEF1FF' }, // 主色 + 悬停 + 浅底
          canvas:  '#F6F7FB',   // 页面背景
          surface: '#FFFFFF',   // 卡片 / 面板背景
          ink:     '#1B1F2A',   // 主文字
          muted:   '#6B7280',   // 次要文字
          line:    '#E7E9EF',   // 边框 / 分隔线
          success: '#16A34A',
          warning: '#D97706',
          danger:  '#DC2626',
        },
        borderRadius: { card: '12px', ctrl: '8px' }, // 卡片 / 控件圆角(自定,别千篇一律)
        boxShadow: { card: '0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10)' },
      },
    },
  };
</script>
```

用法:`bg-brand`、`text-muted`、`border-line`、`rounded-card`、`shadow-card`……全套页面统一从这里取。

---

## 3. 共享应用外壳

外壳形态服从产品(中后台侧边导航 / 仪表盘网格 / 工作台顶 tab……),不必拘泥固定式样。下面给一个**经典侧边导航**示例,展示「菜单真实链接跳转 + 当前页高亮」的做法——按你的布局概念改造。

```html
<div class="flex min-h-screen">
  <!-- 侧边导航 -->
  <aside class="w-60 shrink-0 bg-surface border-r border-line flex flex-col">
    <div class="h-14 flex items-center gap-2 px-5 border-b border-line">
      <i class="fa-solid fa-diagram-project text-brand"></i>
      <span class="font-semibold">产品名</span>
    </div>
    <nav class="flex-1 p-3 space-y-1 text-sm">
      <!-- 当前页:加高亮类;其余:普通态 + 真实 href -->
      <a href="document-list.html" class="flex items-center gap-3 px-3 py-2 rounded-ctrl bg-brand-soft text-brand font-medium">
        <i class="fa-solid fa-folder-open w-4 text-center"></i> 文档管理
      </a>
      <a href="qa.html" class="flex items-center gap-3 px-3 py-2 rounded-ctrl text-muted hover:bg-canvas hover:text-ink">
        <i class="fa-regular fa-comments w-4 text-center"></i> 智能问答
      </a>
    </nav>
  </aside>

  <!-- 右侧:顶栏 + 主内容 -->
  <div class="flex-1 flex flex-col min-w-0">
    <header class="h-14 shrink-0 bg-surface border-b border-line flex items-center justify-between px-6">
      <div class="text-sm text-muted">
        <span>文档管理</span> <i class="fa-solid fa-angle-right text-xs mx-1"></i> <span class="text-ink">文档列表</span>
      </div>
      <div class="flex items-center gap-4">
        <i class="fa-regular fa-bell text-muted"></i>
        <img src="<真实头像直链>" alt="用户头像" class="w-8 h-8 rounded-full object-cover" />
      </div>
    </header>
    <main class="flex-1 p-6 overflow-auto">
      <!-- 本页主内容 -->
    </main>
  </div>
</div>
```

`index.html` 可直接用主页面,或做一个简洁的「原型总览」:卡片列出每个页面入口,点进各 `.html`。

---

## 4. 常用组件片段

Antd 作为**交互范式与尺度**参考(按钮高度、表格分页、表单校验、二次确认的范式),**视觉一律用你的 token**。以下片段照此原则给出,直接改色改字。

### 按钮

```html
<!-- 主按钮 -->
<button class="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
  <i class="fa-solid fa-plus"></i> 新建文档
</button>
<!-- 次按钮 -->
<button class="h-9 px-4 rounded-ctrl border border-line bg-surface text-ink text-sm hover:border-brand hover:text-brand">取消</button>
<!-- 危险按钮 -->
<button class="h-9 px-4 rounded-ctrl text-danger text-sm hover:bg-danger/10">删除</button>
```

### 搜索框 / 输入

```html
<div class="relative w-72">
  <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm"></i>
  <input type="text" placeholder="搜索文档名称 / 关键词"
    class="w-full h-9 pl-9 pr-3 rounded-ctrl border border-line bg-surface text-sm focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20" />
</div>
```

### 表格(填真实多行数据,别只放一行)

```html
<div class="bg-surface rounded-card shadow-card overflow-hidden">
  <table class="w-full text-sm">
    <thead>
      <tr class="text-left text-muted bg-canvas/60">
        <th class="font-medium px-4 py-3">文档名称</th>
        <th class="font-medium px-4 py-3">状态</th>
        <th class="font-medium px-4 py-3">创建人</th>
        <th class="font-medium px-4 py-3">更新时间</th>
        <th class="font-medium px-4 py-3 text-right">操作</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-line">
      <tr class="hover:bg-canvas/50">
        <td class="px-4 py-3 font-medium">2024 年安全运维手册.pdf</td>
        <td class="px-4 py-3"><span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-success/10 text-success"><i class="fa-solid fa-circle text-[6px]"></i> 已解析</span></td>
        <td class="px-4 py-3 text-muted">张伟</td>
        <td class="px-4 py-3 text-muted">2026-06-15 14:22</td>
        <td class="px-4 py-3 text-right space-x-3">
          <button class="text-brand hover:underline">查看</button>
          <button class="text-danger hover:underline">删除</button>
        </td>
      </tr>
      <!-- 再写 8~12 行各不相同的真实数据 -->
    </tbody>
  </table>
</div>
```

### 状态标签(语义色)

```html
<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-warning/10 text-warning">解析中</span>
<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-danger/10 text-danger">解析失败</span>
```

### 卡片

```html
<div class="bg-surface rounded-card shadow-card p-5">
  <div class="flex items-center justify-between mb-2">
    <h3 class="font-medium">本月上传</h3>
    <i class="fa-solid fa-arrow-trend-up text-success"></i>
  </div>
  <p class="text-3xl font-semibold tracking-tight">128 <span class="text-base text-muted font-normal">份</span></p>
  <p class="text-xs text-muted mt-1">较上月 +12%</p>
</div>
```

### 弹窗(用 JS 控制 hidden,见第 6 节)

```html
<div id="modal-create" class="fixed inset-0 z-50 hidden">
  <div class="absolute inset-0 bg-black/40" onclick="closeModal('modal-create')"></div>
  <div class="relative mx-auto mt-24 w-[480px] bg-surface rounded-card shadow-xl">
    <div class="flex items-center justify-between px-5 h-14 border-b border-line">
      <h3 class="font-medium">新建文档</h3>
      <button onclick="closeModal('modal-create')" class="text-muted hover:text-ink"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="p-5 space-y-4"><!-- 表单字段 --></div>
    <div class="px-5 h-14 border-t border-line flex items-center justify-end gap-3">
      <button onclick="closeModal('modal-create')" class="h-9 px-4 rounded-ctrl border border-line text-sm">取消</button>
      <button class="h-9 px-4 rounded-ctrl bg-brand text-white text-sm">确定</button>
    </div>
  </div>
</div>
```

### 空状态 / 加载 / 错误(关键交互,别省)

```html
<!-- 空状态 -->
<div class="flex flex-col items-center justify-center py-20 text-center">
  <i class="fa-regular fa-folder-open text-5xl text-line mb-4"></i>
  <p class="text-ink font-medium">还没有任何文档</p>
  <p class="text-sm text-muted mt-1">上传第一份文档,开始构建你的知识库</p>
  <button class="mt-4 h-9 px-4 rounded-ctrl bg-brand text-white text-sm"><i class="fa-solid fa-upload mr-1"></i> 上传文档</button>
</div>
<!-- 加载骨架 -->
<div class="space-y-3 animate-pulse">
  <div class="h-4 bg-line rounded w-1/3"></div>
  <div class="h-10 bg-line/60 rounded"></div>
</div>
```

---

## 5. 真实图片与图标

- **图片(零占位硬要求)**:用 Unsplash / Pexels 真实直链。
  - Unsplash 可用带尺寸参数的直链,如 `https://images.unsplash.com/photo-XXXX?w=400&q=80&auto=format&fit=crop`。
  - 头像可用 `https://i.pravatar.cc/80?img=12` 之类的真实头像服务。
  - 始终给有意义的 `alt`;列表 / 卡片配图用 `object-cover` 控制比例。
- **图标**:FontAwesome 6,挑**语义贴切**的:上传 `fa-upload`、文档 `fa-file-lines`、告警 `fa-triangle-exclamation`、搜索 `fa-magnifying-glass`、设置 `fa-gear`。`fa-solid` / `fa-regular` 按视觉需要选。
- **图表 / 可视化**:原型阶段不必引重型库。简单趋势 / 占比可用纯 CSS(柱:`<div>` 高度)、内联 SVG(折线 `<polyline>` / 环形 `<circle stroke-dasharray>`),或极少量 JS 画 `<canvas>`。重点是"看起来是真实图表",形神到位即可。

---

## 6. 轻量交互(原生 JS)

只服务于演示。一小段全局脚本即可覆盖弹窗、Toast、状态切换:

```html
<script>
  function openModal(id){ document.getElementById(id).classList.remove('hidden'); }
  function closeModal(id){ document.getElementById(id).classList.add('hidden'); }

  function confirmDanger(msg, onOk){ if (window.confirm(msg)) onOk && onOk(); } // 原型期可用,或换成自定义确认弹窗

  function toast(text){
    const t = document.createElement('div');
    t.className = 'fixed top-5 left-1/2 -translate-x-1/2 z-[60] bg-ink text-white text-sm px-4 py-2 rounded-ctrl shadow-lg';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }
</script>
```

- **导航**:菜单 / 关键按钮直接用 `<a href="xxx.html">` 跳转,让 User Flow 主路径能一页页点通。
- **状态演示**:想让评审看到空 / 加载 / 错误态,可放一个小的"演示状态切换"控件,用 JS 切换显示对应区块;或单独留一个空态示例页。
- **校验反馈**:按设计稿的校验时机(失焦 / 提交),用 JS 给输入框加红边 + 错误提示文案;成功操作用 `toast('已发布')`,且反馈文案与按钮动作一致。
