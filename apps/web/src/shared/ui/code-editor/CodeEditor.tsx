import { useEffect, useMemo, useState } from 'react';
import ReactCodeMirror from '@uiw/react-codemirror';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import { useFieldId } from '../form/field-context';
import { mergeClass } from '../form/form-styles';
import { controlRoomEditorTheme, controlRoomHighlightStyle } from './code-editor-theme';
import { resolveLanguageExtensions } from './language-extensions';
import type { CodeEditorProps } from './types';

const defaultBasicSetup = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: false,
  highlightSelectionMatches: false,
  searchKeymap: false,
  foldKeymap: true,
  completionKeymap: false,
  lintKeymap: false,
} as const;

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function';
}

export function CodeEditor({
  value,
  onChange,
  language = 'plain',
  readOnly = false,
  disabled = false,
  placeholder,
  minHeight = '6rem',
  className,
  id,
  'aria-label': ariaLabel,
  basicSetup = defaultBasicSetup,
  lint,
}: CodeEditorProps) {
  const fieldId = useFieldId();
  const resolvedId = id ?? fieldId;
  const isReadOnly = readOnly || disabled;

  // 性能保护：默认不在“首次挂载”就启用 lint（jsonParseLinter 会对全文 JSON.parse）
  // 仅当用户开始编辑后才启用，避免 Modal 打开瞬间卡顿。
  const [lintArmed, setLintArmed] = useState(false);
  const shouldEnableLint = Boolean(lint) && lintArmed;

  const resolvedExtensions = useMemo(
    () => resolveLanguageExtensions(language, shouldEnableLint),
    [language, shouldEnableLint],
  );

  const [asyncLanguageExtensions, setAsyncLanguageExtensions] = useState<Extension[]>([]);
  useEffect(() => {
    if (!isPromiseLike(resolvedExtensions)) return;
    let cancelled = false;
    resolvedExtensions.then((extensions) => {
      if (!cancelled) setAsyncLanguageExtensions(extensions);
    });
    return () => {
      cancelled = true;
    };
  }, [resolvedExtensions]);

  const languageExtensions = isPromiseLike(resolvedExtensions)
    ? asyncLanguageExtensions
    : resolvedExtensions;

  const extensions = useMemo(
    () => [
      controlRoomEditorTheme,
      controlRoomHighlightStyle,
      EditorView.lineWrapping,
      indentUnit.of('  '),
      ...languageExtensions,
    ],
    [languageExtensions],
  );

  const handleChange =
    isReadOnly || !onChange
      ? undefined
      : (nextValue: string) => {
          if (lint && !lintArmed) setLintArmed(true);
          onChange(nextValue);
        };

  return (
    <div
      className={mergeClass(
        'w-full overflow-hidden rounded-ctrl border border-line bg-panel font-mono text-xs transition-colors',
        'hover:border-line/80 has-[:focus-within]:border-brand/50 has-[:focus-within]:ring-2 has-[:focus-within]:ring-brand/30',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <ReactCodeMirror
        id={resolvedId}
        aria-label={ariaLabel}
        value={value}
        onChange={handleChange}
        readOnly={isReadOnly}
        editable={!isReadOnly}
        placeholder={placeholder}
        minHeight={minHeight}
        theme="none"
        basicSetup={basicSetup}
        extensions={extensions}
        className="[&_.cm-editor]:outline-none [&_.cm-scroller]:overflow-auto"
      />
    </div>
  );
}
