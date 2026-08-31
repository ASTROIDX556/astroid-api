import { Controller, Get } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

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
  @ApiResponse({ status: 200, description: 'Dashboard overview with aggregated metrics' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
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
  @ApiResponse({ status: 200, description: 'Spend data grouped by agent' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  spendByAgent(@CurrentUser('organizationId') organizationId: string) {
    return this.analyticsService.spendByAgent(organizationId);
  }
}
