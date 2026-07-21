type Listener = () => void;

const listeners = new Set<Listener>();

/** 订阅运行列表变更（删除 / 新建等），用于刷新侧栏「最近运行」等全局视图 */
export function subscribeRunsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyRunsChanged(): void {
  for (const listener of listeners) listener();
}
