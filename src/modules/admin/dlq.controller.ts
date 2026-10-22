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
import { DlqService } from './dlq.service';
import {
  ListDlqJobsQuery,
  listDlqJobsQuerySchema,
  PurgeDlqDto,
  purgeDlqSchema,
  DlqJobDetails,
  QueueJobCounts,
  DlqJobDetailsDto,
  QueueJobCountsDto,
  PaginatedDlqJobsDto,
  RetryJobResultDto,
  RetryAllResultDto,
  RemoveJobResultDto,
  PurgeResultDto,
} from './dto/dlq.dto';
import { Queues } from '../../queues/queues.constants';

/**
 * Administrative Dead-Letter Queue (DLQ) controller.
 * Restricted strictly to system administrators (OWNER and ADMIN roles).
 */
@ApiTags('admin-dlq')
@ApiBearerAuth('access-token')
@Controller('admin/dlq')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class DlqController {
  constructor(private readonly dlqService: DlqService) {}

  @Get()
  @ApiOperation({
    summary: 'List failed jobs across queues or for a specific queue',
    description:
      'Returns a paginated view of failed / dead-lettered jobs. Omit the queue filter ' +
      'to aggregate results across every registered BullMQ queue.',
  })
  @ApiQuery({ name: 'queue', required: false, type: String, description: 'Restrict to a single queue' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page, max 100 (default 20)' })
  @ApiEnvelope(PaginatedDlqJobsDto, { description: 'Paginated list of failed / dead-lettered jobs' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async listFailedJobs(
    @Query(new ZodValidationPipe(listDlqJobsQuerySchema)) query: ListDlqJobsQuery,
  ) {
    return this.dlqService.listFailedJobs(query);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get queue job counts and DLQ health stats',
    description: 'Returns per-queue BullMQ job counts (failed, active, waiting, delayed, completed, paused).',
  })
  @ApiEnvelope(QueueJobCountsDto, {
    isArray: true,
    description: 'Summary counts across all BullMQ queues',
  })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async getQueueStats(): Promise<QueueJobCounts[]> {
    return this.dlqService.getQueueStats();
  }

  @Post('retry-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry all failed jobs across all queues or a specified queue',
    description: 'Moves every failed job (optionally scoped to one queue) back onto its waiting list.',
  })
  @ApiQuery({ name: 'queue', required: false, type: String, description: 'Restrict the batch retry to one queue' })
  @ApiEnvelope(RetryAllResultDto, { description: 'Results of batch retry operation' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async retryAllJobs(@Query('queue') queue?: string) {
    return this.dlqService.retryAllFailedJobs(queue);
  }

  @Delete('purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Purge failed jobs across all queues or a specified queue',
    description: 'Permanently removes failed jobs after an optional grace period. Destructive operation.',
  })
  @ApiEnvelope(PurgeResultDto, { description: 'Results of purge operation' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async purgeQueue(
    @Query(new ZodValidationPipe(purgeDlqSchema)) query: PurgeDlqDto,
  ) {
    return this.dlqService.purgeQueue(query);
  }

  @Post(':queue/retry-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry all failed jobs in a specific queue',
    description: 'Moves every failed job in the named queue back onto its waiting list.',
  })
  @ApiParam({ name: 'queue', description: 'Target queue name', example: 'webhooks' })
  @ApiEnvelope(RetryAllResultDto, { description: 'Results of batch retry operation' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async retryQueueAllJobs(@Param('queue') queue: string) {
    return this.dlqService.retryAllFailedJobs(queue);
  }

  @Delete(':queue/purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Purge failed jobs in a specific queue',
    description: 'Permanently removes failed jobs in the named queue. Destructive operation.',
  })
  @ApiParam({ name: 'queue', description: 'Target queue name', example: 'webhooks' })
  @ApiEnvelope(PurgeResultDto, { description: 'Results of purge operation' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async purgeSpecificQueue(
    @Param('queue') queue: string,
    @Query(new ZodValidationPipe(purgeDlqSchema)) query: PurgeDlqDto,
  ) {
    return this.dlqService.purgeQueue({ ...query, queue });
  }

  @Get(':queue/:id')
  @ApiOperation({
    summary: 'Inspect a specific failed job and error payload in a named queue',
    description: 'Returns the full failed job record including payload, options, stack trace and timings.',
  })
  @ApiParam({ name: 'queue', description: 'Queue to inspect', example: 'webhooks' })
  @ApiParam({ name: 'id', description: 'BullMQ job id', example: '42' })
  @ApiEnvelope(DlqJobDetailsDto, { description: 'Job inspection details' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, notFound: true, serverError: true })
  async getJobDetails(
    @Param('queue') queue: string,
    @Param('id') id: string,
  ): Promise<DlqJobDetails> {
    return this.dlqService.getJobDetails(queue, id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Inspect a specific failed job in the default Dead-Letter Queue',
    description: 'Returns the full failed job record from the dead-letter queue (or a queue given via query).',
  })
  @ApiParam({ name: 'id', description: 'BullMQ job id', example: '42' })
  @ApiQuery({ name: 'queue', required: false, type: String, description: 'Optional queue override (defaults to dead-letter)' })
  @ApiEnvelope(DlqJobDetailsDto, { description: 'Job inspection details' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, notFound: true, serverError: true })
  async getDlqJobDetails(
    @Param('id') id: string,
    @Query('queue') queue?: string,
  ): Promise<DlqJobDetails> {
    return this.dlqService.getJobDetails(queue ?? Queues.DeadLetter, id);
  }

  @Post(':queue/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a specific failed job in a named queue',
    description: 'Moves one failed job back onto its waiting list. Only jobs in the failed state can be retried.',
  })
  @ApiParam({ name: 'queue', description: 'Queue to retry from', example: 'webhooks' })
  @ApiParam({ name: 'id', description: 'BullMQ job id', example: '42' })
  @ApiEnvelope(RetryJobResultDto, { description: 'Job retry confirmation' })
  @ApiErrorResponses({
    validation: 'Job is not in the failed state',
    unauthorized: true,
    forbidden: true,
    notFound: true,
    serverError: true,
  })
  async retryJob(
    @Param('queue') queue: string,
    @Param('id') id: string,
  ) {
    return this.dlqService.retryJob(queue, id);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a specific failed job in the default Dead-Letter Queue',
    description: 'Moves one failed job back onto its waiting list (dead-letter queue by default).',
  })
  @ApiParam({ name: 'id', description: 'BullMQ job id', example: '42' })
  @ApiQuery({ name: 'queue', required: false, type: String, description: 'Optional queue override (defaults to dead-letter)' })
  @ApiEnvelope(RetryJobResultDto, { description: 'Job retry confirmation' })
  @ApiErrorResponses({
    validation: 'Job is not in the failed state',
    unauthorized: true,
    forbidden: true,
    notFound: true,
    serverError: true,
  })
  async retryDlqJob(
    @Param('id') id: string,
    @Query('queue') queue?: string,
  ) {
    return this.dlqService.retryJob(queue ?? Queues.DeadLetter, id);
  }

  @Delete(':queue/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete/remove a specific failed job from a named queue',
    description: 'Permanently removes a single failed job record. Destructive operation.',
  })
  @ApiParam({ name: 'queue', description: 'Queue to remove from', example: 'webhooks' })
  @ApiParam({ name: 'id', description: 'BullMQ job id', example: '42' })
  @ApiEnvelope(RemoveJobResultDto, { description: 'Job removal confirmation' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, notFound: true, serverError: true })
  async removeJob(
    @Param('queue') queue: string,
    @Param('id') id: string,
  ) {
    return this.dlqService.removeJob(queue, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete/remove a specific failed job from the default Dead-Letter Queue',
    description: 'Permanently removes a single failed job record (dead-letter queue by default). Destructive operation.',
  })
  @ApiParam({ name: 'id', description: 'BullMQ job id', example: '42' })
  @ApiQuery({ name: 'queue', required: false, type: String, description: 'Optional queue override (defaults to dead-letter)' })
  @ApiEnvelope(RemoveJobResultDto, { description: 'Job removal confirmation' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, notFound: true, serverError: true })
  async removeDlqJob(
    @Param('id') id: string,
    @Query('queue') queue?: string,
  ) {
    return this.dlqService.removeJob(queue ?? Queues.DeadLetter, id);
  }
}
