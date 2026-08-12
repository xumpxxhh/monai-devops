/**
 * 子 runId 派生：前缀可读 + 完整字符串短哈希唯一
 * @module executor/child-run-id
 */

const CHILD_RUN_PARENT_PREFIX_LEN = 12;
const CHILD_RUN_STEP_PREFIX_LEN = 12;
const CHILD_RUN_HASH_LEN = 8;

/** FNV-1a 32-bit → base36，截断/补齐到固定长度 */
export function shortHash(input: string, length = CHILD_RUN_HASH_LEN): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const unsigned = hash >>> 0;
  let encoded = unsigned.toString(36);
  if (encoded.length < length) {
    encoded = encoded.padStart(length, '0');
  }
  return encoded.slice(0, length);
}

/**
 * 派生子 run id：`${parentPrefix}__${stepPrefix}__${token}__iter${iteration}`
 * 唯一性来自对完整 parentRunId:stepId 的哈希，前缀仅供人眼可读。
 */
export function deriveChildRunId(parentRunId: string, stepId: string, iteration: number): string {
  const parentPrefix = parentRunId.slice(0, CHILD_RUN_PARENT_PREFIX_LEN);
  const stepPrefix = stepId.slice(0, CHILD_RUN_STEP_PREFIX_LEN);
  const token = shortHash(`${parentRunId}:${stepId}`);
  return `${parentPrefix}__${stepPrefix}__${token}__iter${iteration}`;
}
