import type { BasicSetupOptions } from '@uiw/react-codemirror';

export type CodeEditorLanguage = 'plain' | 'json' | 'yaml' | 'xml' | 'javascript' | 'shell';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: CodeEditorLanguage;
  readOnly?: boolean;
  disabled?: boolean;
  placeholder?: string;
  minHeight?: string;
  className?: string;
  id?: string;
  'aria-label'?: string;
  basicSetup?: boolean | BasicSetupOptions;
  /** 是否启用语法 lint；json 默认 true，其余默认 false */
  lint?: boolean;
}
