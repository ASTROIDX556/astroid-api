import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { QueueManagementService } from './queue-management.service';
import {
  ListFailedJobsFilterDto,
  listFailedJobsFilterSchema,
  BatchRetryFilterDto,
  batchRetryFilterSchema,
  BatchPurgeFilterDto,
  batchPurgeFilterSchema,
  ListFailedJobsFilterDtoSwagger,
  BatchOperationFilterDtoSwagger,
} from './queue-management.dto';
import {
  FailedJobDto,
  BatchRetryResultDto,
  BatchPurgeResultDto,
  QueueHealthDto,
} from './queue-management.dto';
import { DlqJobDetailsDto } from './dto/dlq.dto';
import {
  FailedJobInspection,
  BatchRetryResult,
  BatchPurgeResult,
  QueueHealthSnapshot,
} from './queue-management.service';

/**
 * Administrative Queue Management controller providing advanced DLQ
 * inspection, filtering, batch requeue, and purge endpoints.
 *
 * All endpoints are restricted to system administrators (OWNER and ADMIN roles)
 * via the `@Roles` decorator. Inputs are validated using Zod schemas piped
 * through the global ZodValidationPipe.
 *
 * This controller complements the existing DlqController by providing
 * richer filtering (time range, reason substring, job name) and batch
 * operations with granular error reporting.
 */
@ApiTags('admin-queue-management')
@ApiBearerAuth('access-token')
@Controller('admin/queues')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class QueueManagementController {
  constructor(private readonly queueManagement: QueueManagementService) {}

  // ---------------------------------------------------------------------------
  // Inspection Endpoints
  // ---------------------------------------------------------------------------

  @Get('failed')
  @ApiOperation({
    summary: 'List failed jobs with advanced filtering',
    description:
      'Returns a paginated list of failed jobs across all queues or a specific queue. ' +
      'Supports filtering by failed reason substring, job name, and time range.',
  })
  @ApiQuery({ type: ListFailedJobsFilterDtoSwagger })
  @ApiEnvelope(FailedJobDto, {
    isArray: true,
    description: 'Paginated list of failed jobs',
  })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async listFailedJobs(
    @Query(new ZodValidationPipe(listFailedJobsFilterSchema)) query: ListFailedJobsFilterDto,
  ) {
    return this.queueManagement.listFailedJobs(query);
  }

  @Get('failed/:queue/:id')
  @ApiOperation({
    summary: 'Inspect a specific failed job',
    description:
      'Returns detailed information about a specific failed job including ' +
      'payload, error details, stack trace, and derived status.',
  })
  @ApiParam({ name: 'queue', description: 'Queue to inspect', example: 'webhooks' })
  @ApiParam({ name: 'id', description: 'BullMQ job id', example: '42' })
  @ApiEnvelope(DlqJobDetailsDto, { description: 'Job inspection details' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, notFound: true, serverError: true })
  async inspectJob(
    @Param('queue') queue: string,
    @Param('id') id: string,
  ): Promise<FailedJobInspection> {
    return this.queueManagement.inspectJob(queue, id);
  }

  // ---------------------------------------------------------------------------
  // Health Endpoints
  // ---------------------------------------------------------------------------

  @Get('health')
  @ApiOperation({
    summary: 'Get queue health snapshot',
    description:
      'Returns health metrics for every registered queue including job counts, ' +
      'total processed jobs, and timestamps of oldest/newest failed jobs.',
  })
  @ApiEnvelope(QueueHealthDto, {
    isArray: true,
    description: 'Queue health metrics',
  })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async getQueueHealth(): Promise<QueueHealthSnapshot[]> {
    return this.queueManagement.getQueueHealth();
  }

  // ---------------------------------------------------------------------------
  // Batch Operations
  // ---------------------------------------------------------------------------

  @Post('retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch retry failed jobs with filtering',
    description:
      'Retries failed jobs matching the specified filter criteria. ' +
      'Returns granular results including per-job success/failure counts.',
  })
  @ApiQuery({ type: BatchOperationFilterDtoSwagger })
  @ApiEnvelope(BatchRetryResultDto, { description: 'Batch retry results' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async batchRetry(
    @Query(new ZodValidationPipe(batchRetryFilterSchema)) query: BatchRetryFilterDto,
  ): Promise<BatchRetryResult> {
    return this.queueManagement.batchRetry(query);
  }

  @Post(':queue/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch retry failed jobs in a specific queue',
    description:
      'Retries all failed jobs in the specified queue, optionally filtered by ' +
      'reason, job name, and time range.',
  })
  @ApiParam({ name: 'queue', description: 'Target queue name', example: 'webhooks' })
  @ApiQuery({ type: BatchOperationFilterDtoSwagger })
  @ApiEnvelope(BatchRetryResultDto, { description: 'Batch retry results' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async batchRetryInQueue(
    @Param('queue') queue: string,
    @Query(new ZodValidationPipe(batchRetryFilterSchema)) query: BatchRetryFilterDto,
  ): Promise<BatchRetryResult> {
    return this.queueManagement.batchRetry({ ...query, queue });
  }

  @Delete('purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch purge failed jobs with filtering',
    description:
      'Permanently removes failed jobs matching the specified filter criteria. ' +
      'This is a destructive operation — purged jobs cannot be recovered.',
  })
  @ApiQuery({ type: BatchOperationFilterDtoSwagger })
  @ApiEnvelope(BatchPurgeResultDto, { description: 'Batch purge results' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async batchPurge(
    @Query(new ZodValidationPipe(batchPurgeFilterSchema)) query: BatchPurgeFilterDto,
  ): Promise<BatchPurgeResult> {
    return this.queueManagement.batchPurge(query);
  }

  @Delete(':queue/purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch purge failed jobs in a specific queue',
    description:
      'Permanently removes all failed jobs in the specified queue, optionally ' +
      'filtered by reason, job name, and time range.',
  })
  @ApiParam({ name: 'queue', description: 'Target queue name', example: 'webhooks' })
  @ApiQuery({ type: BatchOperationFilterDtoSwagger })
  @ApiEnvelope(BatchPurgeResultDto, { description: 'Batch purge results' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async batchPurgeInQueue(
    @Param('queue') queue: string,
    @Query(new ZodValidationPipe(batchPurgeFilterSchema)) query: BatchPurgeFilterDto,
  ): Promise<BatchPurgeResult> {
    return this.queueManagement.batchPurge({ ...query, queue });
  }
}
