import { resolve, sep } from 'node:path';

export const CONTAINER_WORKSPACE = '/workspace';

export type DockerNetworkMode = 'none' | 'bridge' | 'host';

export interface DockerSandboxOptions {
  workspaceDir: string;
  cwd: string;
  command: string;
  image: string;
  network: DockerNetworkMode;
  uid: number;
  gid: number;
}

export interface DockerRunInvocation {
  command: 'docker';
  args: string[];
}

function resolveContainerWorkdir(workspaceDir: string, cwd: string): string {
  const root = resolve(workspaceDir);
  const target = resolve(cwd);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target === root) {
    return CONTAINER_WORKSPACE;
  }
  if (!target.startsWith(rootWithSep)) {
    throw new Error(`cwd 不在 workspace 内：${cwd}`);
  }
  const relative = target.slice(root.length).replaceAll('\\', '/');
  return `${CONTAINER_WORKSPACE}${relative.startsWith('/') ? relative : `/${relative}`}`;
}

export function buildDockerRunInvocation(options: DockerSandboxOptions): DockerRunInvocation {
  const workdir = resolveContainerWorkdir(options.workspaceDir, options.cwd);
  const mount = `${options.workspaceDir}:${CONTAINER_WORKSPACE}:rw`;

  const args = [
    'run',
    '--rm',
    '--init',
    `--network=${options.network}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--user=${options.uid}:${options.gid}`,
  ];

  if (options.network === 'bridge') {
    args.push('--add-host=host.docker.internal:host-gateway');
  }

  args.push(`-v=${mount}`, `-w=${workdir}`, options.image, 'sh', '-lc', options.command);

  return { command: 'docker', args };
}

export function resolveDockerImage(configured?: string): string {
  const fromConfig = configured?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = process.env.SANDBOX_DOCKER_IMAGE?.trim();
  return fromEnv || 'node:20-bookworm';
}

export function resolveDockerNetwork(configured?: DockerNetworkMode): DockerNetworkMode {
  if (configured) {
    return configured;
  }
  const fromEnv = process.env.SANDBOX_DOCKER_NETWORK?.trim();
  if (fromEnv === 'none' || fromEnv === 'bridge' || fromEnv === 'host') {
    return fromEnv;
  }
  return 'bridge';
}

export function resolveProcessIds(): { uid: number; gid: number } {
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    return { uid: process.getuid(), gid: process.getgid() };
  }
  return { uid: 1000, gid: 1000 };
}
