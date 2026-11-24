import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** A captured dead-letter queue entry. */
export class DeadLetterEntryDto {
  @ApiProperty({ description: 'Event id of the captured failure', example: 'evt_018f...' })
  id!: string;

  @ApiProperty({ description: 'Queue the failed job belonged to', example: 'webhooks' })
  queue!: string;

  @ApiProperty({ description: 'BullMQ id of the failed job', example: '42' })
  jobId!: string;

  @ApiPropertyOptional({ description: 'Why the job failed', example: 'HTTP 500 from the partner endpoint' })
  failedReason?: string;

  @ApiPropertyOptional({ description: 'When the job failed', example: '2026-01-15T10:30:00.000Z' })
  failedAt?: string;
}

/** The acknowledgement returned when a failed job is re-driven. */
export class DeadLetterRetryDto {
  @ApiProperty({ description: 'Queue the job belonged to', example: 'webhooks' })
  queue!: string;

  @ApiProperty({ description: 'BullMQ id of the failed job', example: '42' })
  jobId!: string;

  @ApiProperty({ description: 'Id of the newly enqueued job', example: '43' })
  requeuedJobId!: string;
}

/** The acknowledgement returned when a failed job is purged. */
export class DeadLetterPurgeDto {
  @ApiProperty({ description: 'Queue the job belonged to', example: 'webhooks' })
  queue!: string;

  @ApiProperty({ description: 'BullMQ id of the purged job', example: '42' })
  jobId!: string;

  @ApiProperty({ description: 'Whether the job was purged', example: true })
  purged!: boolean;
}
