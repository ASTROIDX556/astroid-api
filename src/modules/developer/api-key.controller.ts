import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { SensitiveRateLimit } from '../../common/decorators/sensitive-rate-limit.decorator';
import { ApiEnvelope, ApiPaginatedEnvelope } from '../../common/decorators/api-envelope.decorator';
import { UserRole } from '@prisma/client';
import { ApiKeyService } from './api-key.service';
import {
  createApiKeySchema,
  CreateApiKeyInput,
  CreateApiKeyDto,
  ApiKeyCreatedDto,
  rotateApiKeySchema,
  RotateApiKeyInput,
  RotateApiKeyDto,
  ApiKeyRotatedDto,
  ApiKeyResponseDto,
  ApiKeyRevokedDto,
} from './api-key.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequiredScopes } from '../../common/decorators/scopes.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { AuditLog } from '../../common/decorators/audit-log.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';
import { ApiAuthenticated } from '../../common/decorators/api-authenticated.decorator';

@ApiTags('developer')
@ApiAuthenticated()
@Controller('developer/api-keys')
@ApiErrorResponses({ unauthorized: true, forbidden: true, tooManyRequests: true, serverError: true })
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Get()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequiredScopes('read')
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
  @RequiredScopes('write')
  @SensitiveRateLimit('apiKeyCreate')
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
    tooManyRequests: true,
    serverError: true,
    serviceUnavailable: 'Rate limiting is unavailable, so the endpoint refuses requests (fails closed)',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyInput,
  ) {
    return this.apiKeyService.create(user.organizationId, user.id, body);
  }

  @Post(':id/rotate')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequiredScopes('write')
  @SensitiveRateLimit('apiKeyCreate')
  @AuditAction('AGENT_KEY_ROTATED')
  @AuditLog({ action: 'AGENT_KEY_ROTATED', entity: 'ApiKey' })
  @ApiOperation({
    summary: 'Rotate an API key',
    description:
      'Issues a replacement key while the previous key remains valid for a configurable grace window, ' +
      'then expires automatically. The new key is returned exactly once.',
  })
  @ApiParam({ name: 'id', description: 'API key UUID to rotate', example: '018f0a1b-4444-4000-8000-000000000000' })
  @ApiBody({ type: RotateApiKeyDto, required: false })
  @ApiEnvelope(ApiKeyRotatedDto, {
    status: 200,
    description: 'API key rotated successfully (new full key included)',
  })
  @ApiErrorResponses({
    validation: true,
    unauthorized: true,
    forbidden: true,
    notFound: true,
    conflict: 'Key is already revoked, expired, or currently rotating',
    tooManyRequests: true,
    serverError: true,
    serviceUnavailable: 'Rate limiting is unavailable, so the endpoint refuses requests (fails closed)',
  })
  rotate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rotateApiKeySchema)) body: RotateApiKeyInput,
  ) {
    return this.apiKeyService.rotate(user.organizationId, user.id, id, body);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequiredScopes('write')
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
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.apiKeyService.revoke(user.organizationId, id, user.id);
  }
}
