import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { OrganizationService } from './organization.service';
import {
  inviteMemberSchema,
  InviteMemberInput,
  rotateKeysSchema,
  RotateKeysInput,
  updateMemberSchema,
  UpdateMemberInput,
  updateOrganizationSchema,
  UpdateOrganizationInput,
} from './organization.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get('current')
  @ApiOperation({ summary: 'Get the current organization' })
  getCurrent(@CurrentUser('organizationId') organizationId: string) {
    return this.organizationService.getCurrent(organizationId);
  }

  @Patch('current')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Update the current organization' })
  updateCurrent(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateOrganizationSchema)) body: UpdateOrganizationInput,
  ) {
    return this.organizationService.updateCurrent(user.organizationId, user.id, body);
  }

  @Get('members')
  @ApiOperation({ summary: 'List organization members' })
  listMembers(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.organizationService.listMembers(organizationId, query);
  }

  @Post('members')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Invite a new member' })
  inviteMember(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: InviteMemberInput,
  ) {
    return this.organizationService.inviteMember(user.organizationId, user.id, body);
  }

  @Patch('members/:id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a member role or status' })
  updateMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) body: UpdateMemberInput,
  ) {
    return this.organizationService.updateMember(user.organizationId, user.id, id, body);
  }

  @Delete('members/:id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Remove (soft) a member' })
  removeMember(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.organizationService.removeMember(user.organizationId, user.id, id);
  }

  @Post('keys/rotate')
  @Roles(UserRole.OWNER)
  @ApiOperation({
    summary: 'Rotate the organization admin API key',
    description:
      'Revokes every active admin key and issues a fresh one. The new key is returned ' +
      'exactly once — only its SHA-256 hash is stored, so an old key can never be recovered. ' +
      'Organization owners only.',
  })
  rotateKeys(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(rotateKeysSchema)) body: RotateKeysInput,
  ) {
    return this.organizationService.rotateKeys(user.organizationId, user.id, body);
  }
}
