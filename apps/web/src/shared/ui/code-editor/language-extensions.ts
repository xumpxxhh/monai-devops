import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import type { CodeEditorLanguage } from './types';

type LanguageExtensionFactory = (options: { lint: boolean }) => Extension[] | Promise<Extension[]>;

const languageRegistry: Partial<Record<CodeEditorLanguage, LanguageExtensionFactory>> = {
  plain: () => [],

  json: ({ lint }) => {
    const extensions: Extension[] = [json()];
    if (lint) {
      extensions.push(linter(jsonParseLinter()));
    }
    return extensions;
  },

  // 后续按需安装语言包并在注册表启用：
  // yaml: async () => { const { yaml } = await import('@codemirror/lang-yaml'); return [yaml()]; },
  // xml: async () => { const { xml } = await import('@codemirror/lang-xml'); return [xml()]; },
  // javascript: async () => { const { javascript } = await import('@codemirror/lang-javascript'); return [javascript()]; },
};

function defaultLintForLanguage(language: CodeEditorLanguage): boolean {
  return language === 'json';
}

export function resolveLanguageExtensions(
  language: CodeEditorLanguage,
  lint?: boolean,
): Extension[] | Promise<Extension[]> {
  const factory = languageRegistry[language];
  if (!factory) {
    throw new Error(
      `CodeEditor: language "${language}" is not configured yet. Add the lang package and register it in language-extensions.ts.`,
    );
  }
  const enableLint = lint ?? defaultLintForLanguage(language);
  return factory({ lint: enableLint });
}
