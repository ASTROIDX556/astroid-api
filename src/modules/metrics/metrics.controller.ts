import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import { MetricsService } from './metrics.service';
import { MetricsAccessGuard } from './metrics-access.guard';
import { Public } from '../../common/decorators/public.decorator';
import { SkipAudit } from '../../common/decorators/skip-audit.decorator';

/**
 * Prometheus scrape endpoint. Public (no JWT/API key) but restricted to
 * internal network ranges by `MetricsAccessGuard`, and excluded from both
 * the audit trail and the global response envelope since scrapers expect
 * raw Prometheus text exposition format.
 */
@ApiExcludeController()
@Controller('metrics')
@Public()
@SkipAudit()
@UseGuards(MetricsAccessGuard)
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    const metrics = await this.metricsService.getMetrics();
    res.setHeader('Content-Type', this.metricsService.contentType);
    res.status(200).send(metrics);
  }
}
