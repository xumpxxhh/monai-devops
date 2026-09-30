import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EXECUTION_REPOSITORY } from '../../src/execution/execution.repository.js';
import { PrismaExecutionRepository } from '../../src/execution/prisma-execution.repository.js';
import { WorkerTransportController } from '../../src/execution/worker-transport.controller.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const port = Number(process.env.TEST_TRANSPORT_PORT);
const token = process.env.TEST_TRANSPORT_TOKEN;
if (!Number.isInteger(port) || port < 1 || !token) {
  throw new Error('Test transport port or token is missing');
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();
  const module = await Test.createTestingModule({
    controllers: [WorkerTransportController],
    providers: [
      { provide: EXECUTION_REPOSITORY, useValue: new PrismaExecutionRepository(prisma) },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => (key === 'EXECUTOR_WORKER_HTTP_TOKEN' ? token : undefined),
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api/v1/devops');
  await app.listen(port, '127.0.0.1');
  process.stdout.write('READY\n');
  process.on('SIGTERM', () => {
    void app.close().finally(() => prisma.$disconnect().finally(() => process.exit(0)));
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
