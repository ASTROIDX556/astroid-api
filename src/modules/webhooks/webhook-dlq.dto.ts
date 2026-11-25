import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One HTTP attempt of a dead-lettered delivery. */
export class WebhookAttemptHistoryDto {
  @ApiProperty({ description: '1-based attempt index within the delivery', example: 1 })
  attemptNumber!: number;

  @ApiProperty({ description: 'Outcome of the attempt', enum: ['SUCCEEDED', 'FAILED'], example: 'FAILED' })
  status!: string;

  @ApiPropertyOptional({ description: 'HTTP status the endpoint answered with', example: 503 })
  responseStatus?: number | null;

  @ApiPropertyOptional({ description: 'Machine-readable failure code', example: 'HTTP_503' })
  errorCode?: string | null;

  @ApiPropertyOptional({ description: 'Bounded failure detail (never a secret)', example: 'HTTP 503' })
  errorMessage?: string | null;

  @ApiProperty({ description: 'Round-trip time of the attempt, in milliseconds', example: 128 })
  durationMs!: number;

  @ApiProperty({ description: 'When the attempt ran', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}

/** A webhook delivery that exhausted its retries (or was rejected permanently). */
export class WebhookDeadLetterDto {
  @ApiProperty({ description: 'Delivery id', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Webhook (subscription) id', format: 'uuid' })
  webhookId!: string;

  @ApiPropertyOptional({ description: 'Domain event id', example: 'evt_018f...' })
  eventId?: string;

  @ApiProperty({ description: 'Domain event name', example: 'transaction.completed' })
  eventType!: string;

  @ApiProperty({ description: 'Number of attempts made before dead-lettering', example: 5 })
  attemptsMade!: number;

  @ApiProperty({ description: 'Why the delivery was dead-lettered', example: 'HTTP 503' })
  lastError!: string;

  @ApiPropertyOptional({ description: 'Last HTTP status the endpoint answered with', example: 503 })
  statusCode?: number;

  @ApiProperty({ description: 'When the delivery was dead-lettered', example: '2026-01-15T10:30:00.000Z' })
  failedAt!: string;

  @ApiPropertyOptional({ description: 'When an operator last replayed the delivery', example: '2026-01-15T11:00:00.000Z' })
  replayedAt?: string | null;

  @ApiPropertyOptional({
    description: 'Append-only attempt history (present when inspecting one delivery)',
    type: [WebhookAttemptHistoryDto],
  })
  attemptHistory?: WebhookAttemptHistoryDto[];
}

/** Acknowledgement returned when a dead-lettered delivery is replayed. */
export class WebhookDeadLetterReplayDto {
  @ApiProperty({ description: 'BullMQ id of the replayed delivery job', example: 'webhook-replay-018f...' })
  jobId!: string;

  @ApiProperty({ description: 'The dead-letter record the replay was created from', type: WebhookDeadLetterDto })
  record!: WebhookDeadLetterDto;
}
