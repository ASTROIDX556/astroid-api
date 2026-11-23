import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { WebhookService } from './webhook.service';
import {
  createWebhookSchema,
  CreateWebhookInput,
  listDeliveriesSchema,
  ListDeliveriesQuery,
  updateWebhookSchema,
  UpdateWebhookInput,
} from './webhook.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { API_KEY_SCOPES } from '../../common/constants/api-key-scopes';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PaginationQuery, paginationQuerySchema } from '../../common/pagination';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Get()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.WebhookRead)
  @ApiOperation({ summary: 'List webhooks (signing secrets are never returned)' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.webhookService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.WebhookManage)
  @ApiOperation({
    summary: 'Create a webhook',
    description: 'The HMAC signing secret is returned exactly once in this response.',
  })
  create(
    @CurrentUser('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(createWebhookSchema)) body: CreateWebhookInput,
  ) {
    return this.webhookService.create(organizationId, body);
  }

  // Declared before `:id` so the literal path is matched first.
  @Get('deliveries')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.WebhookRead)
  @ApiOperation({
    summary: 'List webhook delivery attempts',
    description:
      'Includes retry state (attempts, last/next attempt, status code, error). ' +
      'Filter with status=FAILED_PERMANENTLY to list the dead-letter queue.',
  })
  listDeliveries(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(listDeliveriesSchema)) query: ListDeliveriesQuery,
  ) {
    return this.webhookService.listDeliveries(organizationId, query);
  }

  @Get(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.WebhookRead)
  @ApiOperation({ summary: 'Get a webhook' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.webhookService.get(organizationId, id);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.WebhookManage)
  @ApiOperation({ summary: 'Update a webhook' })
  update(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateWebhookSchema)) body: UpdateWebhookInput,
  ) {
    return this.webhookService.update(organizationId, id, body);
  }

  @Post(':id/rotate-secret')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.WebhookManage)
  @ApiOperation({ summary: 'Rotate the signing secret (returned once)' })
  rotate(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.webhookService.rotateSecret(organizationId, id);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER)
  @RequireScopes(API_KEY_SCOPES.WebhookManage)
  @ApiOperation({ summary: 'Delete a webhook' })
  remove(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.webhookService.remove(organizationId, id);
  }
}
