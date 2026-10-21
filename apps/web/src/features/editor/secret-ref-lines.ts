export function parseSecretRefLines(input: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const raw of input.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const separator = line.indexOf('=');
    const alias = line.slice(0, separator).trim();
    const ref = line.slice(separator + 1).trim();
    if (
      separator < 1 ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(alias) ||
      !/^secret:\/\/env\/[A-Z][A-Z0-9_]{0,127}$/.test(ref) ||
      Object.hasOwn(refs, alias)
    ) {
      throw new Error(`无效的 Secret 引用：${line}`);
    }
    refs[alias] = ref;
  }
  return refs;
}
