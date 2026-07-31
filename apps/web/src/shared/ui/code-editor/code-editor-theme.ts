import { EditorView } from '@codemirror/view';

/** Control Room 浅色主题，色值对齐 tailwind.config.js */
export const controlRoomEditorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#F3F5FA',
      color: '#1A2030',
      fontSize: '12px',
      fontFamily: 'var(--mono)',
    },
    '.cm-content': {
      caretColor: '#6D5EF6',
      padding: '8px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#6D5EF6',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(109, 94, 246, 0.22) !important',
    },
    '.cm-gutters': {
      backgroundColor: '#F3F5FA',
      color: '#98A2B4',
      border: 'none',
      borderRight: '1px solid #E4E8F1',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(109, 94, 246, 0.06)',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(109, 94, 246, 0.04)',
    },
    '.cm-line': {
      padding: '0 4px 0 2px',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'rgba(109, 94, 246, 0.12)',
    },
    '.cm-tooltip': {
      backgroundColor: '#FFFFFF',
      border: '1px solid #E4E8F1',
      borderRadius: '9px',
      color: '#1A2030',
    },
    '.cm-tooltip-lint': {
      backgroundColor: '#FFFFFF',
    },
    '.cm-diagnostic': {
      padding: '4px 8px',
    },
    '.cm-diagnostic-error': {
      borderLeft: '3px solid #E11D48',
    },
    '.cm-lintRange-error': {
      backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 3 l2 -2 l1 0 l2 2 l1 0' stroke='%23E11D48' fill='none' stroke-width='1'/></svg>")`,
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'rgba(109, 94, 246, 0.10)',
      border: 'none',
      color: '#6D5EF6',
    },
  },
  { dark: false },
);

/** JSON 等语言的语法高亮配色 */
export const controlRoomHighlightStyle = EditorView.baseTheme({
  '& .tok-string': { color: '#16A34A' },
  '& .tok-number': { color: '#0EA5E9' },
  '& .tok-bool': { color: '#6D5EF6' },
  '& .tok-null': { color: '#98A2B4' },
  '& .tok-propertyName': { color: '#5C667A' },
  '& .tok-punctuation': { color: '#98A2B4' },
  '& .tok-keyword': { color: '#6D5EF6' },
  '& .tok-comment': { color: '#98A2B4', fontStyle: 'italic' },
});
