import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentRepository } from './agent.repository';
import { EncryptionModule } from '../../common/encryption/encryption.module';

/** Agent lifecycle management. */
@Module({
  imports: [EncryptionModule],
  controllers: [AgentController],
  providers: [AgentService, AgentRepository],
  exports: [AgentService],
})
export class AgentModule {}
