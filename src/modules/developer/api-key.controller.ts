import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { ApiEnvelope, ApiPaginatedEnvelope } from '../../common/decorators/api-envelope.decorator';
import { UserRole } from '@prisma/client';
import { ApiKeyService } from './api-key.service';
import { createApiKeySchema, CreateApiKeyInput, CreateApiKeyDto, ApiKeyCreatedDto } from './api-key.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { AuditLog } from '../../common/decorators/audit-log.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';
import { ApiKeyResponseDto, ApiKeyRevokedDto } from './api-key.dto';

@ApiTags('developer')
@ApiBearerAuth('access-token')
@Controller('developer/api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Get()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @ApiOperation({
    summary: 'List API keys (secrets are never returned)',
    description:
      'Returns a paginated list of API keys for the current organization. ' +
      'Full secrets are never included — only prefix and metadata.',
  })
  @ApiPaginationQuery()
  @ApiPaginatedEnvelope(ApiKeyResponseDto, { description: 'Paginated list of API keys' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.apiKeyService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @AuditAction('AGENT_KEY_ROTATED')
  @AuditLog({ action: 'AGENT_KEY_CREATED', entity: 'ApiKey' })
  @ApiOperation({
    summary: 'Create an API key',
    description:
      'The full key is returned exactly once and only its hash is stored. ' +
      'Store the key securely — it cannot be retrieved later.',
  })
  @ApiBody({ type: CreateApiKeyDto })
  @ApiEnvelope(ApiKeyCreatedDto, {
    status: 201,
    description: 'API key created successfully (full key included)',
  })
  @ApiErrorResponses({
    validation: true,
    unauthorized: true,
    forbidden: true,
    serverError: true,
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
  @AuditLog({ action: 'AGENT_KEY_REVOKED', entity: 'ApiKey' })
  @ApiOperation({
    summary: 'Revoke an API key',
    description:
      'Permanently revokes the API key. The key can no longer be used for authentication. ' +
      'This action cannot be undone.',
  })
  @ApiParam({ name: 'id', description: 'API key UUID', example: '018f0a1b-...' })
  @ApiEnvelope(ApiKeyRevokedDto, { description: 'API key revoked successfully' })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: true,
    notFound: true,
    serverError: true,
  })
  revoke(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.apiKeyService.revoke(organizationId, id);
  }
}
