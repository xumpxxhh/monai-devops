import { lazy } from 'react';

export { CodeEditor } from './CodeEditor';
export type { CodeEditorLanguage, CodeEditorProps } from './types';

export const LazyCodeEditor = lazy(() =>
  import('./CodeEditor').then((module) => ({ default: module.CodeEditor })),
);
