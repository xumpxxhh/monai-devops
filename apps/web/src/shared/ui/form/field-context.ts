import { createContext, useContext } from 'react';

const FieldIdContext = createContext<string | undefined>(undefined);

export const FieldIdProvider = FieldIdContext.Provider;

/** 由 Field 注入的控件 id，供 Input / Select 等子组件自动关联 label */
export function useFieldId() {
  return useContext(FieldIdContext);
}
