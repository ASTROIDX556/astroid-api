import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ApiKeyService } from './api-key.service';
import { createApiKeySchema, CreateApiKeyInput } from './api-key.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
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

  @Post(':id/rotate')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @ApiOperation({
    summary: 'Rotate an API key',
    description: 'Generates a replacement key while keeping the predecessor valid for a configurable grace period. The replacement key is returned in plaintext exactly once.',
  })
  rotate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') keyId: string,
  ) {
    return this.apiKeyService.rotateKey(user.organizationId, user.id, keyId);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @ApiOperation({ summary: 'Revoke an API key' })
  revoke(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.apiKeyService.revoke(organizationId, id);
  }
}
