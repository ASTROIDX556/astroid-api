import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBody,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import { z } from 'zod';
import { AiService } from './ai.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AiBriefingDto, ChatMessageDto, AiChatResponseDto, ChatRequestDto } from './ai.dto';
import { ApiAuthenticated } from '../../common/decorators/api-authenticated.decorator';

const chatSchema = z.object({ message: z.string().min(1).max(2000) });
type ChatInput = z.infer<typeof chatSchema>;

@ApiTags('ai')
@ApiAuthenticated()
@Controller('ai')
@ApiErrorResponses({ unauthorized: true, forbidden: true, tooManyRequests: true, serverError: true })
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('briefing')
  @ApiOperation({
    summary: 'Generate a daily executive AI briefing for the organization',
    description:
      'Generates a comprehensive briefing summarizing key financial activities, ' +
      'agent performance, policy compliance, and risk alerts for the current day.',
  })
  @ApiEnvelope(AiBriefingDto, {
    description: 'Daily executive briefing with insights and recommendations',
  })
  @ApiErrorResponses({ unauthorized: true, tooManyRequests: true, serverError: true })
  getBriefing(@CurrentUser('organizationId') organizationId: string) {
    return this.aiService.getBriefing(organizationId);
  }

  @Get('assistant/seed')
  @ApiOperation({
    summary: 'Return the seeded assistant conversation transcript',
    description:
      'Returns the initial conversation transcript for the AI assistant. ' +
      'This is used to bootstrap the assistant with context about the organization.',
  })
  @ApiEnvelope(ChatMessageDto, {
    isArray: true,
    description: 'Seeded conversation transcript',
  })
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  getSeed() {
    return this.aiService.getSeed();
  }

  @Post('chat')
  @ApiOperation({
    summary: 'Send a message to the AI assistant',
    description:
      'Sends a user message to the AI assistant and returns the response. ' +
      'The assistant has access to the organization\'s financial data and can answer questions ' +
      'about transactions, policies, budgets, and agents.',
  })
  @ApiBody({ type: ChatRequestDto })
  @ApiEnvelope(AiChatResponseDto, { description: 'AI assistant response' })
  @ApiErrorResponses({
    validation: 'Validation error (empty or too long message)',
    unauthorized: true,
    tooManyRequests: true,
    serverError: true,
  })
  async chat(@Body(new ZodValidationPipe(chatSchema)) body: ChatInput) {
    const reply = await this.aiService.chat(body.message);
    return { reply };
  }
}
