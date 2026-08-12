import { EditorView } from '@codemirror/view';

/** Control Room 浅色主题，色值对齐 index.css :root token */
export const controlRoomEditorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--panel)',
      color: 'var(--ink)',
      fontSize: '12px',
      fontFamily: 'var(--mono)',
    },
    '.cm-content': {
      caretColor: 'var(--brand)',
      padding: '8px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--brand)',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgb(var(--brand-rgb) / 0.22) !important',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--panel)',
      color: 'var(--faint)',
      border: 'none',
      borderRight: '1px solid var(--line)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgb(var(--brand-rgb) / 0.06)',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgb(var(--brand-rgb) / 0.04)',
    },
    '.cm-line': {
      padding: '0 4px 0 2px',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'rgb(var(--brand-rgb) / 0.12)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--surface)',
      border: '1px solid var(--line)',
      borderRadius: '9px',
      color: 'var(--ink)',
    },
    '.cm-tooltip-lint': {
      backgroundColor: 'var(--surface)',
    },
    '.cm-diagnostic': {
      padding: '4px 8px',
    },
    '.cm-diagnostic-error': {
      borderLeft: '3px solid var(--failed)',
    },
    '.cm-lintRange-error': {
      backgroundImage: 'var(--lint-error-wave)',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'rgb(var(--brand-rgb) / 0.10)',
      border: 'none',
      color: 'var(--brand)',
    },
  },
  { dark: false },
);

/** JSON 等语言的语法高亮配色 */
export const controlRoomHighlightStyle = EditorView.baseTheme({
  '& .tok-string': { color: 'var(--completed)' },
  '& .tok-number': { color: 'var(--running)' },
  '& .tok-bool': { color: 'var(--brand)' },
  '& .tok-null': { color: 'var(--faint)' },
  '& .tok-propertyName': { color: 'var(--muted)' },
  '& .tok-punctuation': { color: 'var(--faint)' },
  '& .tok-keyword': { color: 'var(--brand)' },
  '& .tok-comment': { color: 'var(--faint)', fontStyle: 'italic' },
});
