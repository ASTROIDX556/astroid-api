import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { AuditListener } from './audit.listener';

/**
 * Audit module. Globally exported so any module can record audit entries
 * directly; the listener also captures every domain event automatically.
 * Includes cryptographic hash chaining for tamper-evident audit history.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditRepository, AuditHashService, AuditListener],
  exports: [AuditService],
})
export class AuditModule {}
