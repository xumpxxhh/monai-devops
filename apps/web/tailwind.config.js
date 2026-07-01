/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#6D5EF6', hover: '#5848E0', soft: 'rgba(109,94,246,0.10)' },
        canvas: '#F5F6FB',
        surface: '#FFFFFF',
        raised: '#EEF1F8',
        panel: '#F3F5FA',
        ink: '#1A2030',
        muted: '#5C667A',
        faint: '#98A2B4',
        line: '#E4E8F1',
        'line-soft': '#EEF1F7',
        completed: '#16A34A',
        running: '#0EA5E9',
        queued: '#D97706',
        failed: '#E11D48',
        skipped: '#64748B',
        success: '#16A34A',
        warning: '#D97706',
        danger: '#E11D48',
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
        card: '0 1px 2px rgba(16,24,40,.06), 0 8px 24px -14px rgba(16,24,40,.18)',
        pop: '0 12px 40px -8px rgba(16,24,40,.20)',
      },
    },
  },
  plugins: [],
};
