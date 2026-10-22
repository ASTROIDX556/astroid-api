import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { ApiEnvelope, ApiPaginatedEnvelope } from '../../common/decorators/api-envelope.decorator';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { UserRole } from '@prisma/client';
import { DeadLetterService } from './dead-letter.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { DeadLetterEntryDto, DeadLetterRetryDto, DeadLetterPurgeDto } from './dead-letter.dto';

/**
 * Administrative dead-letter queue endpoints. Read-only inspection of captured
 * job failures plus a guarded re-drive action for remediated failures.
 * Restricted to owners/admins like the audit trail.
 */
@ApiTags('dead-letter')
@ApiBearerAuth('access-token')
@Controller('admin/dead-letter')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class DeadLetterController {
  constructor(private readonly deadLetterService: DeadLetterService) {}

  @Get()
  @ApiOperation({
    summary: 'List captured DLQ failures for the organization',
    description:
      'Returns the durable ledger entries for terminally failed background jobs, ' +
      'newest first. Optionally restricted to a single queue.',
  })
  @ApiPaginationQuery()
  @ApiQuery({ name: 'queue', required: false, type: String, description: 'Restrict entries to a single queue', example: 'webhooks' })
  @ApiPaginatedEnvelope(DeadLetterEntryDto, {
    description: 'Paginated list of DLQ ledger entries for the organization',
  })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: 'Insufficient permissions (requires OWNER or ADMIN)',
    serverError: true,
  })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query('queue') queue: string | undefined,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.deadLetterService.listForOrganization(organizationId, queue, query);
  }

  @Post(':queue/:jobId/retry')
  @ApiOperation({
    summary: 'Re-drive a failed job back onto its queue',
    description:
      'Enqueues a copy of a previously failed job so it can be retried after the ' +
      'underlying cause has been remediated. The original failure record stays intact.',
  })
  @ApiParam({ name: 'queue', description: 'Queue the failed job belongs to', example: 'webhooks' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job id of the failed job', example: '42' })
  @ApiEnvelope(DeadLetterRetryDto, { description: 'Re-drive accepted; returns the new job id' })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: 'Insufficient permissions (requires OWNER or ADMIN)',
    notFound: true,
    serverError: true,
  })
  retry(@Param('queue') queue: string, @Param('jobId') jobId: string) {
    return this.deadLetterService.requeue(queue, jobId);
  }

  @Delete(':queue/:jobId')
  @ApiOperation({
    summary: 'Purge a failed job from the queue after review',
    description: 'Permanently removes a failed job from Redis after operator review. Destructive operation.',
  })
  @ApiParam({ name: 'queue', description: 'Queue the failed job belongs to', example: 'webhooks' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job id of the failed job', example: '42' })
  @ApiEnvelope(DeadLetterPurgeDto, { description: 'Job purged' })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: 'Insufficient permissions (requires OWNER or ADMIN)',
    notFound: true,
    serverError: true,
  })
  purge(@Param('queue') queue: string, @Param('jobId') jobId: string) {
    return this.deadLetterService.purge(queue, jobId);
  }
}
