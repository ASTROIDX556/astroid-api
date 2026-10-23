import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { ApprovalDecision, UserRole } from '@prisma/client';
import { ApprovalService } from './approval.service';
import {
  decideProposalSchema,
  DecideProposalInput,
  DecideProposalDto,
  decisionCommentSchema,
  DecisionCommentInput,
  DecisionCommentDto,
  ProposalResponseDto,
} from './approval.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';
import { ApiEnvelope, ApiPaginatedEnvelope } from '../../common/decorators/api-envelope.decorator';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';

@ApiTags('approvals')
@ApiBearerAuth('access-token')
@Controller('proposals')
export class ApprovalController {
  constructor(private readonly approvalService: ApprovalService) {}

  @Get()
  @ApiOperation({
    summary: 'List approval proposals',
    description:
      'Returns a paginated list of approval proposals for the current organization. ' +
      'Supports filtering by status.',
  })
  @ApiPaginationQuery()
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'], description: 'Filter by proposal status' })
  @ApiPaginatedEnvelope(ProposalResponseDto, { description: 'Paginated list of proposals' })
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.approvalService.list(organizationId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a proposal with its approvals',
    description:
      'Returns full details of a proposal including all approval/rejection decisions.',
  })
  @ApiParam({ name: 'id', description: 'Proposal UUID', example: '018f0a1b-...' })
  @ApiEnvelope(ProposalResponseDto, { description: 'Proposal details with approvals' })
  @ApiErrorResponses({ unauthorized: true, notFound: true, serverError: true })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.approvalService.getOrThrow(organizationId, id);
  }

  @Post(':id/decision')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('PROPOSAL_DECIDED')
  @ApiOperation({
    summary: 'Approve or reject a proposal',
    description:
      'When the approval threshold is met the underlying transaction is executed automatically. ' +
      'A single rejection from an authorized reviewer rejects the whole proposal.',
  })
  @ApiParam({ name: 'id', description: 'Proposal UUID', example: '018f0a1b-...' })
  @ApiBody({ type: DecideProposalDto })
  @ApiEnvelope(ProposalResponseDto, {
    description: 'Decision recorded (transaction may execute automatically)',
  })
  @ApiErrorResponses({
    validation: true,
    unauthorized: true,
    forbidden: true,
    notFound: true,
    conflict: 'Proposal already decided or expired',
    serverError: true,
  })
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decideProposalSchema)) body: DecideProposalInput,
  ) {
    return this.approvalService.decide(user.organizationId, user.id, id, body);
  }

  @Post(':id/approve')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('PROPOSAL_APPROVED')
  @ApiOperation({
    summary: 'Approve a proposal (PRD alias of POST /:id/decision)',
    description:
      'Records an APPROVED vote. When the approval threshold is met the ' +
      'underlying transaction is executed automatically.',
  })
  @ApiParam({ name: 'id', description: 'Proposal UUID', example: '018f0a1b-...' })
  @ApiBody({ type: DecisionCommentDto })
  @ApiEnvelope(ProposalResponseDto, {
    description: 'Approval recorded (transaction may execute automatically)',
  })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: true,
    notFound: true,
    conflict: 'Proposal already decided or expired',
    serverError: true,
  })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decisionCommentSchema)) body: DecisionCommentInput,
  ) {
    return this.approvalService.decide(user.organizationId, user.id, id, {
      decision: ApprovalDecision.APPROVED,
      comment: body.comment,
    });
  }

  @Post(':id/reject')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('PROPOSAL_REJECTED')
  @ApiOperation({
    summary: 'Reject a proposal (PRD alias of POST /:id/decision)',
    description:
      'A single rejection rejects the whole proposal and cancels the transaction.',
  })
  @ApiParam({ name: 'id', description: 'Proposal UUID', example: '018f0a1b-...' })
  @ApiBody({ type: DecisionCommentDto })
  @ApiEnvelope(ProposalResponseDto, { description: 'Rejection recorded (transaction cancelled)' })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: true,
    notFound: true,
    conflict: 'Proposal already decided or expired',
    serverError: true,
  })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decisionCommentSchema)) body: DecisionCommentInput,
  ) {
    return this.approvalService.decide(user.organizationId, user.id, id, {
      decision: ApprovalDecision.REJECTED,
      comment: body.comment,
    });
  }
}
