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
import { createQueueRegistrationOptions } from '../../queues/queue-policy';

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
  ],
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditRepository,
    AuditHashService,
    AuditListener,
    AuditRecordedListener,
    AuditCleanupQueue,
  ],
  exports: [AuditService],
})
export class AuditModule {}
