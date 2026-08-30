import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentStatus, UserRole } from '@prisma/client';
import { AgentService } from './agent.service';
import {
  assignWalletSchema,
  AssignWalletInput,
  createAgentSchema,
  CreateAgentInput,
  updateAgentSchema,
  UpdateAgentInput,
} from './agent.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UseAgentLock } from '../../common/locks/agent-lock.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';

@ApiTags('agents')
@Controller('agents')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get()
  @ApiOperation({ summary: 'List agents' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.agentService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @ApiOperation({ summary: 'Register a new agent' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createAgentSchema)) body: CreateAgentInput,
  ) {
    return this.agentService.create(user.organizationId, user.id, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an agent' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.agentService.getOrThrow(organizationId, id);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @UseAgentLock()
  @ApiOperation({ summary: 'Update an agent' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAgentSchema)) body: UpdateAgentInput,
  ) {
    return this.agentService.update(user.organizationId, user.id, id, body);
  }

  @Post(':id/pause')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @UseAgentLock()
  @ApiOperation({ summary: 'Pause an agent' })
  pause(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.agentService.setStatus(user.organizationId, user.id, id, AgentStatus.PAUSED);
  }

  @Post(':id/resume')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @UseAgentLock()
  @ApiOperation({ summary: 'Reactivate an agent' })
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.agentService.setStatus(user.organizationId, user.id, id, AgentStatus.ACTIVE);
  }

  @Post(':id/suspend')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @UseAgentLock()
  @ApiOperation({ summary: 'Suspend an agent' })
  suspend(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.agentService.setStatus(user.organizationId, user.id, id, AgentStatus.SUSPENDED);
  }

  @Post(':id/wallet')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @UseAgentLock()
  @ApiOperation({ summary: 'Assign a primary wallet to an agent' })
  assignWallet(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignWalletSchema)) body: AssignWalletInput,
  ) {
    return this.agentService.assignWallet(user.organizationId, user.id, id, body);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @UseAgentLock()
  @ApiOperation({ summary: 'Archive (soft delete) an agent' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.agentService.remove(user.organizationId, user.id, id);
  }
}
