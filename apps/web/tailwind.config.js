/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'rgb(var(--brand-rgb) / <alpha-value>)',
          hover: 'rgb(var(--brand-hover-rgb) / <alpha-value>)',
          soft: 'var(--brand-soft)',
        },
        canvas: 'rgb(var(--canvas-rgb) / <alpha-value>)',
        surface: 'rgb(var(--surface-rgb) / <alpha-value>)',
        raised: 'rgb(var(--raised-rgb) / <alpha-value>)',
        panel: 'rgb(var(--panel-rgb) / <alpha-value>)',
        ink: 'rgb(var(--ink-rgb) / <alpha-value>)',
        muted: 'rgb(var(--muted-rgb) / <alpha-value>)',
        faint: 'rgb(var(--faint-rgb) / <alpha-value>)',
        line: 'rgb(var(--line-rgb) / <alpha-value>)',
        'line-soft': 'rgb(var(--line-soft-rgb) / <alpha-value>)',
        completed: 'rgb(var(--completed-rgb) / <alpha-value>)',
        running: 'rgb(var(--running-rgb) / <alpha-value>)',
        queued: 'rgb(var(--queued-rgb) / <alpha-value>)',
        failed: 'rgb(var(--failed-rgb) / <alpha-value>)',
        skipped: 'rgb(var(--skipped-rgb) / <alpha-value>)',
        success: 'rgb(var(--completed-rgb) / <alpha-value>)',
        warning: 'rgb(var(--queued-rgb) / <alpha-value>)',
        danger: 'rgb(var(--failed-rgb) / <alpha-value>)',
      },
      fontFamily: {
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      borderRadius: { card: '14px', ctrl: '9px', pill: '999px' },
      boxShadow: {
        card: '0 1px 2px rgb(var(--shadow-ink-rgb) / 0.06), 0 8px 24px -14px rgb(var(--shadow-ink-rgb) / 0.18)',
        pop: '0 12px 40px -8px rgb(var(--shadow-ink-rgb) / 0.20)',
      },
    },
  },
  plugins: [],
};
