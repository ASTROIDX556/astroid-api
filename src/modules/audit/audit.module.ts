import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { AuditListener } from './audit.listener';
import { AuditRecordedListener } from './audit-recorded.listener';
import { Queues } from '../../queues/queues.constants';
import { redisConfig } from '../../config/redis.config';
import { AuditCleanupQueue } from './queues/audit-cleanup.queue';
import { AuditArchiveRepository } from './audit-archive.repository';
import { AuditArchiveService } from './audit-archive.service';
import { AuditArchiveScheduler } from './audit-archive.scheduler';
import { AuditArchiveWorker } from './queues/audit-archive.worker';
import { MetricsModule } from '../metrics/metrics.module';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';

@Global()
@Module({
  imports: [
    MetricsModule,
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
  ],
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditRepository,
    AuditHashService,
    AuditListener,
    AuditRecordedListener,
    AuditCleanupQueue,
    AuditArchiveRepository,
    AuditArchiveService,
    AuditArchiveScheduler,
    AuditArchiveWorker,
  ],
  exports: [AuditService],
})
export class AuditModule {}
