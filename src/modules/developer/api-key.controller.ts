import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ApiKeyService } from './api-key.service';
import { createApiKeySchema, CreateApiKeyInput } from './api-key.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';

@ApiTags('developer')
@Controller('developer/api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Get()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @ApiOperation({ summary: 'List API keys (secrets are never returned)' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.apiKeyService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('AGENT_KEY_ROTATED')
  @ApiOperation({
    summary: 'Create an API key',
    description: 'The full key is returned exactly once and only its hash is stored.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyInput,
  ) {
    return this.apiKeyService.create(user.organizationId, user.id, body);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('AGENT_KEY_REVOKED')
  @ApiOperation({ summary: 'Revoke an API key' })
  revoke(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.apiKeyService.revoke(organizationId, id);
  }
}
