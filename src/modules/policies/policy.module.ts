import { Module } from '@nestjs/common';
import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';
import { PolicyRepository } from './policy.repository';
import { PolicyEngine } from './policy.engine';
import { PolicyOverrideCleanupService } from './services/policy-override-cleanup.service';

/**
 * Policy module. Exports the service + engine so the transactions module can
 * evaluate intents during the payment pipeline.
 */
@Module({
  controllers: [PolicyController],
  providers: [PolicyService, PolicyRepository, PolicyEngine, PolicyOverrideCleanupService],
  exports: [PolicyService, PolicyEngine, PolicyOverrideCleanupService],
})
export class PolicyModule {}
