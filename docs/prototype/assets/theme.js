/*
 * MONAI DevOps 控制台原型 · 设计 token
 * 浅色 "Control Room (Light)" 主题:洁净浅灰底 + 电光紫品牌色 + 一套贴合内核语义的状态色。
 * 必须在 Tailwind Play CDN 之后、内容渲染之前加载。
 */
tailwind.config = {
  theme: {
    extend: {
      colors: {
        brand:   { DEFAULT: '#6D5EF6', hover: '#5848E0', soft: 'rgba(109,94,246,0.10)' },
        canvas:  '#F5F6FB', // 页面背景(洁净浅灰)
        surface: '#FFFFFF', // 卡片 / 面板
        raised:  '#EEF1F8', // 悬浮 / 选中 / hover
        panel:   '#F3F5FA', // 嵌入式区块(日志台、画布底、代码块)
        ink:     '#1A2030', // 主文字
        muted:   '#5C667A', // 次要文字
        faint:   '#98A2B4', // 更弱文字 / 占位
        line:    '#E4E8F1', // 边框 / 分隔线
        'line-soft': '#EEF1F7',
        // —— 内核语义状态色(完成/运行/排队/失败/跳过),浅底上加深以保对比 ——
        completed: '#16A34A', // step:finished status=completed
        running:   '#0EA5E9', // step:start
        queued:    '#D97706', // step:queued(挂起等资源)
        failed:    '#E11D48', // status=failed
        skipped:   '#64748B', // status=skipped
        // 语义别名
        success: '#16A34A',
        warning: '#D97706',
        danger:  '#E11D48',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: { card: '14px', ctrl: '9px', pill: '999px' },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.06), 0 8px 24px -14px rgba(16,24,40,.18)',
        pop:  '0 12px 40px -8px rgba(16,24,40,.20)',
      },
    },
  },
};
