import { Controller, Get } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import { AnalyticsService } from './analytics.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AnalyticsOverviewDto, AgentSpendDto } from './analytics.dto';

@ApiTags('analytics')
@ApiBearerAuth('access-token')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Dashboard overview: counts, spend and distributions',
    description:
      'Returns a high-level overview of the organization including agent counts, ' +
      'total spend, transaction counts, and policy compliance metrics.',
  })
  @ApiEnvelope(AnalyticsOverviewDto, { description: 'Dashboard overview with aggregated metrics' })
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  overview(@CurrentUser('organizationId') organizationId: string) {
    return this.analyticsService.overview(organizationId);
  }

  @Get('spend-by-agent')
  @ApiOperation({
    summary: 'Completed spend grouped by agent',
    description:
      'Returns spending data broken down by agent, including total spend, ' +
      'transaction count, and average transaction size.',
  })
  @ApiEnvelope(AgentSpendDto, {
    isArray: true,
    description: 'Spend data grouped by agent',
  })
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  spendByAgent(@CurrentUser('organizationId') organizationId: string) {
    return this.analyticsService.spendByAgent(organizationId);
  }
}
