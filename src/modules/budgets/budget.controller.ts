import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { BudgetService } from './budget.service';
import {
  allocateBudgetSchema,
  AllocateBudgetInput,
  createBudgetSchema,
  CreateBudgetInput,
  updateBudgetSchema,
  UpdateBudgetInput,
} from './budget.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/pagination';

@ApiTags('budgets')
@Controller('budgets')
export class BudgetController {
  constructor(private readonly budgetService: BudgetService) {}

  @Get()
  @ApiOperation({ summary: 'List budgets' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.budgetService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Create a budget' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createBudgetSchema)) body: CreateBudgetInput,
  ) {
    return this.budgetService.create(user.organizationId, user.id, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a budget with remaining balance and children' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.budgetService.getDetail(organizationId, id);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Update a budget' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateBudgetSchema)) body: UpdateBudgetInput,
  ) {
    return this.budgetService.update(user.organizationId, user.id, id, body);
  }

  @Post(':id/allocate')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Allocate funds from the parent budget to this child' })
  allocate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(allocateBudgetSchema)) body: AllocateBudgetInput,
  ) {
    return this.budgetService.allocate(user.organizationId, user.id, id, body);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Delete (soft) a budget' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.budgetService.remove(user.organizationId, user.id, id);
  }
}
