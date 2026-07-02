/**
 * Config 校验辅助
 * @module validation
 */

import type { ZodError } from 'zod';

/**
 * 将 Zod 校验错误格式化为人类可读字符串（含字段路径）
 */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
