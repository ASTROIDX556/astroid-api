import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import { RiskService } from './risk.service';
import { assessRiskSchema, AssessRiskInput, AssessRiskDto } from './risk.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RiskAssessmentDto } from './risk.dto';

@ApiTags('risk')
@ApiBearerAuth('access-token')
@Controller('risk')
export class RiskController {
  constructor(private readonly riskService: RiskService) {}

  @Post('assess')
  @ApiOperation({
    summary: 'Assess the risk score of a hypothetical transaction',
    description:
      'Evaluates a transaction intent and returns a risk score with detailed factors. ' +
      'Consider using POST /transactions/simulate for full governance pipeline evaluation.',
  })
  @ApiBody({ type: AssessRiskDto })
  @ApiEnvelope(RiskAssessmentDto, { description: 'Risk assessment with score and detailed factors' })
  @ApiErrorResponses({ validation: true, unauthorized: true, serverError: true })
  assess(
    @CurrentUser('organizationId') _organizationId: string,
    @Body(new ZodValidationPipe(assessRiskSchema)) body: AssessRiskInput,
  ) {
    return this.riskService.assess(body);
  }
}
