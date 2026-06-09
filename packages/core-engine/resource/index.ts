/**
 * 资源管理器
 * @module resource
 */

/**
 * 资源定义
 */
export interface Resource {
  id: string;
  type: string;
  name: string;
  status: 'available' | 'allocated' | 'released';
  metadata?: Record<string, unknown>;
}

/**
 * 资源池配置
 */
export interface ResourcePoolOptions {
  maxResources?: number;
  autoCleanup?: boolean;
  cleanupInterval?: number;
  /** 有新空闲资源时回调（供 resource-scheduler 唤醒等待队列） */
  onResourceAvailable?: (type: string) => void;
}

/**
 * 创建资源管理器
 */
export function createResourceManager(options: ResourcePoolOptions = {}) {
  const {
    maxResources = 10,
    autoCleanup = true,
    cleanupInterval = 60000,
    onResourceAvailable,
  } = options;

  const resources: Map<string, Resource> = new Map();
  let cleanupTimer: NodeJS.Timeout | null = null;
  const allocationLock = new Set<string>();

  if (autoCleanup) {
    startAutoCleanup();
  }

  function registerResource(resource: Resource): boolean {
    if (resources.size >= maxResources) {
      return false;
    }
    resources.set(resource.id, { ...resource });
    if (resource.status === 'available') {
      onResourceAvailable?.(resource.type);
    }
    return true;
  }

  function hasAvailable(type: string, name?: string): boolean {
    for (const resource of resources.values()) {
      if (allocationLock.has(resource.id)) continue;
      if (
        resource.type === type &&
        resource.status === 'available' &&
        (!name || resource.name === name)
      ) {
        return true;
      }
    }
    return false;
  }

  function allocateResource(type: string, name?: string): Resource | null {
    for (const resource of resources.values()) {
      if (allocationLock.has(resource.id)) continue;

      if (
        resource.type === type &&
        resource.status === 'available' &&
        (!name || resource.name === name)
      ) {
        allocationLock.add(resource.id);
        try {
          if (resource.status !== 'available') {
            return null;
          }
          resource.status = 'allocated';
          return { ...resource };
        } finally {
          allocationLock.delete(resource.id);
        }
      }
    }
    return null;
  }

  function releaseResource(id: string): boolean {
    if (allocationLock.has(id)) {
      return false;
    }

    allocationLock.add(id);
    try {
      const resource = resources.get(id);
      if (resource && resource.status === 'allocated') {
        if (autoCleanup) {
          resource.status = 'released';
          setTimeout(() => {
            resources.delete(id);
          }, cleanupInterval);
        } else {
          resource.status = 'available';
          onResourceAvailable?.(resource.type);
        }
        return true;
      }
      return false;
    } finally {
      allocationLock.delete(id);
    }
  }

  function getResource(id: string): Resource | undefined {
    const resource = resources.get(id);
    return resource ? { ...resource } : undefined;
  }

  function getAllResources(): Resource[] {
    return Array.from(resources.values()).map((r) => ({ ...r }));
  }

  function getAvailableResources(type?: string): Resource[] {
    return Array.from(resources.values())
      .filter((r) => r.status === 'available' && (!type || r.type === type))
      .map((r) => ({ ...r }));
  }

  function cleanupResources(): number {
    let cleaned = 0;
    for (const [id, resource] of resources.entries()) {
      if (resource.status === 'released') {
        resources.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  function startAutoCleanup(): void {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      cleanupResources();
    }, cleanupInterval);
  }

  function stopAutoCleanup(): void {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }

  function destroy(): void {
    stopAutoCleanup();
    resources.clear();
    allocationLock.clear();
  }

  return {
    registerResource,
    hasAvailable,
    allocateResource,
    releaseResource,
    getResource,
    getAllResources,
    getAvailableResources,
    cleanupResources,
    startAutoCleanup,
    stopAutoCleanup,
    destroy,
  };
}
