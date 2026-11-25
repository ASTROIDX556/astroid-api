import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

import { ApiAuthenticated } from '../../common/decorators/api-authenticated.decorator';
import { ApiEnvelope, ApiPaginatedEnvelope } from '../../common/decorators/api-envelope.decorator';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequiredScopes } from '../../common/decorators/scopes.decorator';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { WebhookDeadLetterDto, WebhookDeadLetterReplayDto } from './webhook-dlq.dto';
import { WebhookDlqService } from './services/webhook-dlq.service';

/**
 * Operator surface for dead-lettered webhook deliveries.
 *
 * A delivery that exhausts its retries is moved to the dead-letter queue by the
 * webhook worker; these routes expose that durable record — failure reason,
 * attempt count and append-only attempt history — and let an owner or admin
 * replay one after the subscriber has been fixed.
 *
 * Restricted to `OWNER`/`ADMIN` (like the audit trail) and scoped to the caller's
 * organization, so a replay can never reach another tenant's delivery or bypass
 * authentication. Replays are audited and refused while another delivery of the
 * same event and subscription is in flight.
 */
@ApiTags('webhooks')
@ApiAuthenticated()
@Controller('admin/webhooks/dead-letters')
@Roles(UserRole.OWNER, UserRole.ADMIN)
@ApiErrorResponses({ unauthorized: true, forbidden: true, tooManyRequests: true, serverError: true })
export class WebhookDlqController {
  constructor(private readonly dlqService: WebhookDlqService) {}

  @Get()
  @RequiredScopes('read')
  @ApiOperation({
    summary: 'List dead-lettered webhook deliveries',
    description:
      'Returns the webhook deliveries that exhausted their retry budget (or were rejected ' +
      'permanently), newest first, with the failure reason and attempt count. Optionally ' +
      'restricted to one subscription with `filter`.',
  })
  @ApiPaginationQuery()
  @ApiPaginatedEnvelope(WebhookDeadLetterDto, {
    description: 'Paginated list of dead-lettered webhook deliveries',
  })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.dlqService.listFailedDeliveries(organizationId, query.page, query.limit);
  }

  @Get(':id')
  @RequiredScopes('read')
  @ApiOperation({
    summary: 'Inspect a dead-lettered webhook delivery',
    description:
      'Returns one dead-lettered delivery with its failure reason and append-only attempt ' +
      'history (attempt number, outcome, HTTP status, failure code and duration).',
  })
  @ApiParam({ name: 'id', description: 'Dead-letter delivery id', example: '018f0a1b-...' })
  @ApiEnvelope(WebhookDeadLetterDto, { description: 'Dead-lettered webhook delivery' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, notFound: true, serverError: true })
  inspect(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
  ) {
    return this.dlqService.getFailedDelivery(organizationId, id);
  }

  @Post(':id/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiredScopes('webhooks:manage')
  @AuditAction('WEBHOOK_DELIVERY_REPLAYED')
  @ApiOperation({
    summary: 'Replay a dead-lettered webhook delivery',
    description:
      'Re-enqueues the delivery on the webhooks queue with a fresh attempt budget. The ' +
      'original failure record is kept for audit. Answers 409 while another delivery of the ' +
      'same event and subscription is in flight, so a replay can never run concurrently ' +
      'with the automatic retry of the same delivery.',
  })
  @ApiParam({ name: 'id', description: 'Dead-letter delivery id', example: '018f0a1b-...' })
  @ApiEnvelope(WebhookDeadLetterReplayDto, {
    status: 202,
    description: 'Replay accepted; returns the new job id',
  })
  @ApiErrorResponses({
    validation: 'The delivery is not dead-lettered',
    unauthorized: true,
    forbidden: 'Insufficient permissions (requires OWNER or ADMIN)',
    notFound: true,
    tooManyRequests: true,
    serverError: true,
  })
  replay(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
  ) {
    return this.dlqService.replayDeadLetter(organizationId, id);
  }
}
