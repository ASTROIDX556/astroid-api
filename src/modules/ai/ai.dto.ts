import { ApiProperty } from '@nestjs/swagger';

/** A single insight of the daily executive briefing. */
export class AiInsightDto {
  @ApiProperty({ description: 'Stable identifier of the insight', example: 'spend-anomaly-1' })
  id!: string;

  @ApiProperty({ description: 'Short headline of the insight', example: 'Spend increased 40% this week' })
  title!: string;

  @ApiProperty({ description: 'Explanation of the insight', example: 'Two agents exceeded their weekly budget.' })
  detail!: string;

  @ApiProperty({
    description: 'How urgent the insight is',
    enum: ['info', 'success', 'warning', 'danger'],
    example: 'warning',
  })
  severity!: string;
}

/** The daily executive briefing. */
export class AiBriefingDto {
  @ApiProperty({ description: 'Greeting of the briefing', example: 'Good day.' })
  greeting!: string;

  @ApiProperty({ description: 'Summary of the current financial state', example: 'All systems nominal.' })
  summary!: string;

  @ApiProperty({ description: 'Moment the briefing was generated', example: '2026-01-15T10:30:00.000Z' })
  generatedAt!: string;

  @ApiProperty({ type: [AiInsightDto], description: 'Insights derived from the last 24 hours' })
  insights!: AiInsightDto[];

  @ApiProperty({
    type: Object,
    description: 'Actions the operator can take, each with the prompt to run',
    example: [{ label: 'Review pending approvals', prompt: 'List the proposals waiting for approval' }],
  })
  suggestedActions!: Array<{ label: string; prompt: string }>;
}

/** One message of the seeded assistant conversation. */
export class ChatMessageDto {
  @ApiProperty({ description: 'Message id', example: 'msg_018f...' })
  id!: string;

  @ApiProperty({ description: 'Who wrote the message', enum: ['user', 'assistant'], example: 'assistant' })
  role!: string;

  @ApiProperty({ description: 'Message body', example: 'Two proposals are waiting for your approval.' })
  content!: string;

  @ApiProperty({ description: 'Moment the message was created', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}

/** The answer of the AI assistant. */
export class AiChatResponseDto {
  @ApiProperty({ description: 'The assistant answer', example: 'Two proposals are waiting for your approval.' })
  reply!: string;
}
