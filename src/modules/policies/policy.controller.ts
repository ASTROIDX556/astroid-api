import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PolicyService } from './policy.service';
import {
  createPolicySchema,
  CreatePolicyInput,
  simulatePolicySchema,
  SimulatePolicyInput,
  updatePolicySchema,
  UpdatePolicyInput,
} from './policy.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import {
  PaginationQuery,
  paginationQuerySchema,
} from '../../common/helpers/pagination';

@ApiTags('policies')
@Controller('policies')
export class PolicyController {
  constructor(private readonly policyService: PolicyService) {}

  @Get()
  @ApiOperation({ summary: 'List policies' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.policyService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('POLICY_CREATED')
  @ApiOperation({ summary: 'Create a policy' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createPolicySchema)) body: CreatePolicyInput,
  ) {
    return this.policyService.create(user.organizationId, user.id, body);
  }

  @Post('simulate')
  @ApiOperation({ summary: 'Simulate a transaction intent against active policies' })
  simulate(
    @CurrentUser('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(simulatePolicySchema)) body: SimulatePolicyInput,
  ) {
    return this.policyService.simulate(organizationId, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a policy' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.policyService.getOrThrow(organizationId, id);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @AuditAction('POLICY_UPDATED')
  @ApiOperation({ summary: 'Update a policy' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePolicySchema)) body: UpdatePolicyInput,
  ) {
    return this.policyService.update(user.organizationId, user.id, id, body);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @AuditAction('POLICY_DELETED')
  @ApiOperation({ summary: 'Delete (soft) a policy' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.policyService.remove(user.organizationId, user.id, id);
  }
}
