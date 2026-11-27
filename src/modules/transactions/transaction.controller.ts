import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiParam,
  ApiBody,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { TransactionService } from './transaction.service';
import { AgentBudgetGuard } from '../budgets/guards/agent-budget.guard';
import {
  createTransactionSchema,
  CreateTransactionInput,
  CreateTransactionDto,
  TransactionResponseDto,
  TransactionSimulationDto,
  TransactionSubmissionDto,
  simulateTransactionSchema,
  SimulateTransactionInput,
} from './transaction.dto';
import { SpendingLimitGuard, RequireSpendingLimitCheck } from './guards/spending-limit.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequiredScopes } from '../../common/decorators/scopes.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { UseWalletLock } from '../../common/locks/wallet-lock.decorator';
import { UseTransactionLock } from '../../common/locks/transaction-lock.decorator';
import { AgentThrottlerGuard } from '../../common/guards/agent-throttler.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import {
  SlidingWindowThrottlerGuard,
  SlidingWindowLimit,
} from '../../common/guards/sliding-window-throttler.guard';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';
import { ApiPageOrCursorPaginatedEnvelope } from '../../common/decorators/api-envelope.decorator';
import { ApiAuthenticated } from '../../common/decorators/api-authenticated.decorator';

@ApiTags('transactions')
@ApiAuthenticated()
@UseGuards(AgentThrottlerGuard)
@Controller('transactions')
@ApiErrorResponses({ unauthorized: true, forbidden: true, tooManyRequests: true, serverError: true })
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Get()
  @ApiOperation({
    summary: 'List transactions',
    description:
      'Returns a paginated list of transactions for the current organization. Supports filtering by status, agent, wallet, and date range.',
  })
  @ApiPaginationQuery()
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Legacy cursor pagination mode' })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'PENDING', 'APPROVED', 'COMPLETED', 'FAILED', 'CANCELLED'], description: 'Filter by transaction status' })
  @ApiQuery({ name: 'agentId', required: false, type: String, description: 'Filter by agent UUID' })
  @ApiQuery({ name: 'walletId', required: false, type: String, description: 'Filter by wallet UUID' })
  @ApiPageOrCursorPaginatedEnvelope(TransactionResponseDto, {
    description: 'Paginated list of transactions',
  })
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery & { cursor?: string; status?: string; search?: string; filter?: string },
  ) {
    return this.transactionService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE, UserRole.DEVELOPER)
  @RequiredScopes('transactions:execute')
  @UseGuards(SlidingWindowThrottlerGuard, SpendingLimitGuard, AgentBudgetGuard)
  @SlidingWindowLimit(30, 60)
  @RequireSpendingLimitCheck()
  @UseWalletLock()
  @UseTransactionLock({ attempts: 3, retryDelayMs: 50 })
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ bodySchema: createTransactionSchema })
  @AuditAction('TRANSFER_FUNDS')
  @ApiOperation({
    summary: 'Create a transaction (runs the full governance pipeline)',
    description:
      'Evaluates policies, scores risk and checks budgets. Auto-executes when permitted, ' +
      'otherwise creates an approval proposal and returns requiresApproval=true. ' +
      'Agent transactions are additionally evaluated against daily/weekly/monthly spending ' +
      'limit policies before reaching the service layer.',
  })
  @ApiBody({ type: CreateTransactionDto })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Required key for replay-safe transaction submission (1-128 allowed ASCII characters). ' +
      'Repeating the same key with the same body replays the original response with ' +
      '`Idempotency-Replayed: true`; reusing it with a different body answers 409 without ' +
      'creating another transaction.',
    required: false,
    description: 'Optional key for replay-safe transaction submission (8-255 characters after trimming).',
  })
  @ApiEnvelope(TransactionSubmissionDto, {
    status: 201,
    description: 'Transaction created (may require approval)',
  })
  @ApiErrorResponses({
    validation: 'Validation error, or a missing/malformed Idempotency-Key header',
    unauthorized: true,
    forbidden: true,
    conflict: 'Insufficient budget, risk threshold exceeded, or the idempotency key is in use',
    unprocessable: 'Transaction blocked by a spending-limit policy (POLICY_VIOLATION)',
    tooManyRequests: true,
    serverError: true,
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createTransactionSchema)) body: CreateTransactionInput,
  ) {
    const actorId = user.isApiKey ? user.createdById ?? user.id : user.id;
    // Idempotency is enforced at the HTTP boundary by IdempotencyInterceptor
    // with the reusable IdempotencyService, so the service call stays focused on
    // the governance pipeline.
    return this.transactionService.create(user.organizationId, actorId, body);
  }

  @Post('simulate')
  @UseGuards(SlidingWindowThrottlerGuard)
  @SlidingWindowLimit(60, 60)
  @ApiOperation({
    summary: 'Dry-run the governance pipeline without moving funds',
    description:
      'Simulates policy evaluation, risk scoring, and budget checks for a hypothetical transaction. ' +
      'Returns the results without creating any records or moving funds.',
  })
  @ApiBody({ type: CreateTransactionDto })
  @ApiEnvelope(TransactionSimulationDto, {
    description: 'Simulation results with policy and risk outcomes',
  })
  @ApiErrorResponses({
    validation: true,
    unauthorized: true,
    tooManyRequests: true,
    serverError: true,
  })
  simulate(
    @CurrentUser('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(simulateTransactionSchema)) body: SimulateTransactionInput,
  ) {
    return this.transactionService.simulate(organizationId, body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a transaction',
    description: 'Returns full details of a single transaction by ID.',
  })
  @ApiParam({ name: 'id', description: 'Transaction UUID', example: '018f0a1b-...' })
   @ApiEnvelope(TransactionResponseDto, { description: 'Transaction details' })
  @ApiErrorResponses({ unauthorized: true, notFound: true, serverError: true })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.transactionService.getOrThrow(organizationId, id);
  }

  @Post(':id/cancel')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('TRANSFER_CANCELLED')
  @ApiOperation({
    summary: 'Cancel a draft or pending transaction',
    description:
      'Cancels a transaction that is in DRAFT or PENDING status. ' +
      'Completed or already cancelled transactions cannot be cancelled.',
  })
  @ApiParam({ name: 'id', description: 'Transaction UUID', example: '018f0a1b-...' })
  @ApiEnvelope(TransactionResponseDto, { description: 'Transaction cancelled successfully' })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: true,
    notFound: true,
    conflict: 'Transaction cannot be cancelled (wrong status) or the idempotency key is in use',
    serverError: true,
  })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.transactionService.cancel(user.organizationId, user.id, id);
  }
}
