import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ApiKeyService } from './api-key.service';
import {
  createApiKeySchema,
  CreateApiKeyInput,
  updateApiKeySchema,
  UpdateApiKeyInput,
} from './api-key.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/pagination';
import { API_KEY_SCOPES } from '../../common/constants/api-key-scopes';

@ApiTags('developer')
@Controller('developer/api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Get()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.ApiKeyManage)
  @ApiOperation({ summary: 'List API keys (secrets are never returned)' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.apiKeyService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.ApiKeyManage)
  @ApiOperation({
    summary: 'Create an API key',
    description:
      'The full key is returned exactly once and only its hash is stored. ' +
      'Scopes restrict what the key can call; unknown scopes are rejected with 400.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyInput,
  ) {
    return this.apiKeyService.create(user.organizationId, user.id, body);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.ApiKeyManage)
  @ApiOperation({ summary: 'Update an API key name, scopes or IP allow-list' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateApiKeySchema)) body: UpdateApiKeyInput,
  ) {
    return this.apiKeyService.update(user.organizationId, user.id, id, body);
  }

  @Post(':id/rotate')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.ApiKeyManage)
  @ApiOperation({
    summary: 'Rotate an API key secret',
    description: 'Returns the new secret exactly once; scopes and settings are preserved.',
  })
  rotate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.apiKeyService.rotate(user.organizationId, user.id, id);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.ApiKeyManage)
  @ApiOperation({ summary: 'Revoke an API key' })
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.apiKeyService.revoke(user.organizationId, user.id, id);
  }
}
