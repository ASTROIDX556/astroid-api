import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger';
import { z } from 'zod';
import { AiService } from './ai.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

const chatSchema = z.object({ message: z.string().min(1).max(2000) });
type ChatInput = z.infer<typeof chatSchema>;

@ApiTags('ai')
@ApiBearerAuth('access-token')
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('briefing')
  @ApiOperation({
    summary: 'Generate a daily executive AI briefing for the organization',
    description:
      'Generates a comprehensive briefing summarizing key financial activities, ' +
      'agent performance, policy compliance, and risk alerts for the current day.',
  })
  @ApiResponse({ status: 200, description: 'Daily executive briefing with insights and recommendations' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
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
  @ApiResponse({ status: 200, description: 'Seeded conversation transcript' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
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
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          example: 'What was our total spend this month?',
          description: 'User message to the AI assistant',
        },
      },
      required: ['message'],
    },
  })
  @ApiResponse({ status: 200, description: 'AI assistant response' })
  @ApiResponse({ status: 400, description: 'Validation error (empty or too long message)' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async chat(@Body(new ZodValidationPipe(chatSchema)) body: ChatInput) {
    const reply = await this.aiService.chat(body.message);
    return { reply };
  }
}
