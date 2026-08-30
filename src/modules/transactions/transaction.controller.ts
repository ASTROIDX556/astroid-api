import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { TransactionService } from './transaction.service';
import {
  createTransactionSchema,
  CreateTransactionInput,
  simulateTransactionSchema,
  SimulateTransactionInput,
} from './transaction.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';

@ApiTags('transactions')
@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Get()
  @ApiOperation({ summary: 'List transactions' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.transactionService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE, UserRole.DEVELOPER)
  @AuditAction('TRANSFER_FUNDS')
  @ApiOperation({
    summary: 'Create a transaction (runs the full governance pipeline)',
    description:
      'Evaluates policies, scores risk and checks budgets. Auto-executes when permitted, ' +
      'otherwise creates an approval proposal and returns requiresApproval=true.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createTransactionSchema)) body: CreateTransactionInput,
  ) {
    return this.transactionService.create(user.organizationId, user.id, body);
  }

  @Post('simulate')
  @ApiOperation({ summary: 'Dry-run the governance pipeline without moving funds' })
  simulate(
    @CurrentUser('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(simulateTransactionSchema)) body: SimulateTransactionInput,
  ) {
    return this.transactionService.simulate(organizationId, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a transaction' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.transactionService.getOrThrow(organizationId, id);
  }

  @Post(':id/cancel')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('TRANSFER_CANCELLED')
  @ApiOperation({ summary: 'Cancel a draft or pending transaction' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.transactionService.cancel(user.organizationId, user.id, id);
  }
}
