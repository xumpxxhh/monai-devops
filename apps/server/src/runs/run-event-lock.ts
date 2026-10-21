import type { Prisma } from '@prisma/client';

/** Serialize all event-index readers/writers for one Run across processes and transactions. */
export async function lockRunEventStream(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ runId: string }>>`
    SELECT "run_id" AS "runId" FROM "runs" WHERE "run_id" = ${runId} FOR UPDATE
  `;
  return rows.length === 1;
}
