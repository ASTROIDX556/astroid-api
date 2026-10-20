import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { AuditListener } from './audit.listener';
import { AuditArchiveService } from './audit-archive.service';
import { AuditArchiveRepository } from './audit-archive.repository';
import { AuditArchiveScheduler } from './audit-archive.scheduler';
import { AuditArchiveWorker } from './queues/audit-archive.worker';
import { Queues } from '../../queues/queues.constants';
import { redisConfig } from '../../config/redis.config';
import { AuditCleanupQueue } from './queues/audit-cleanup.queue';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';
import { MetricsModule } from '../metrics/metrics.module';

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: redisConfig().host,
        port: redisConfig().port,
        password: redisConfig().password,
        db: redisConfig().db,
      },
    }),
    BullModule.registerQueue(createQueueRegistrationOptions(Queues.AuditCleanup)),
    BullModule.registerQueue(createQueueRegistrationOptions(Queues.AuditArchive)),
    MetricsModule,
  ],
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditRepository,
    AuditHashService,
    AuditListener,
    AuditCleanupQueue,
    AuditArchiveService,
    AuditArchiveRepository,
    AuditArchiveScheduler,
    AuditArchiveWorker,
  ],
  exports: [AuditService, AuditArchiveService],
})
export class AuditModule {}
