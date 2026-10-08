import { createHash, timingSafeEqual } from 'node:crypto';
import type { WorkerPluginOffer } from './execution.repository.js';

export interface WorkerIdentity {
  workerId: string;
  tokens: string[];
  plugins: WorkerPluginOffer[];
}

export function parseWorkerIdentities(value: string | undefined): WorkerIdentity[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid worker identities JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) {
    throw new Error('Invalid worker identities');
  }
  const identities = parsed as WorkerIdentity[];
  if (
    identities.some(
      (entry) =>
        !entry ||
        typeof entry.workerId !== 'string' ||
        !entry.workerId.trim() ||
        entry.workerId.length > 128 ||
        !Array.isArray(entry.tokens) ||
        entry.tokens.length < 1 ||
        entry.tokens.length > 2 ||
        entry.tokens.some((token) => typeof token !== 'string' || token.length < 32) ||
        !Array.isArray(entry.plugins) ||
        entry.plugins.length < 1 ||
        entry.plugins.some(
          (plugin) =>
            !plugin ||
            typeof plugin.name !== 'string' ||
            !plugin.name ||
            typeof plugin.version !== 'string' ||
            !plugin.version ||
            !Array.isArray(plugin.capabilities) ||
            plugin.capabilities.some((capability) => typeof capability !== 'string'),
        ),
    ) ||
    new Set(identities.map((entry) => entry.workerId)).size !== identities.length ||
    new Set(identities.flatMap((entry) => entry.tokens)).size !==
      identities.flatMap((entry) => entry.tokens).length
  ) {
    throw new Error('Invalid worker identities');
  }
  return identities;
}

export function authenticateWorker(
  token: string,
  identities: WorkerIdentity[],
): WorkerIdentity | undefined {
  const supplied = createHash('sha256').update(token).digest();
  return identities.find((identity) =>
    identity.tokens.some((candidate) =>
      timingSafeEqual(supplied, createHash('sha256').update(candidate).digest()),
    ),
  );
}

export function workerOffersAllowed(
  offers: WorkerPluginOffer[],
  identity: WorkerIdentity,
): boolean {
  return offers.every((offer) => {
    const allowed = identity.plugins.find(
      (plugin) => plugin.name === offer.name && plugin.version === offer.version,
    );
    return (
      allowed && offer.capabilities.every((capability) => allowed.capabilities.includes(capability))
    );
  });
}
