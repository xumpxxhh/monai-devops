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
  /** 有新空闲资源时回调（供资源等待队列唤醒排队步骤） */
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
      if (
        resource.type === type &&
        resource.status === 'available' &&
        (!name || resource.name === name)
      ) {
        resource.status = 'allocated';
        return { ...resource };
      }
    }
    return null;
  }

  function releaseResource(id: string): boolean {
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

export {
  createResourceWaitQueue,
  type ResourceAcquireRequest,
  type ResourceAcquireResult,
  type ResourcePoolHandle,
  type ResourceWaitQueueOptions,
} from './wait-queue.js';
