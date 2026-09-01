import { Injectable } from '@nestjs/common';
import { Organization, Prisma, UserRole, UserStatus } from '@prisma/client';
import { OrganizationRepository } from './organization.repository';
import {
  InviteMemberInput,
  RotateKeysInput,
  UpdateMemberInput,
  UpdateOrganizationInput,
} from './organization.dto';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { PrismaService } from '../../database/prisma.service';
import { generateApiKey } from '../../utils/crypto.util';

const MEMBER_SORTABLE = ['createdAt', 'name', 'email', 'role', 'status'];

/**
 * Manages the caller's own organization and its members (users). Every query is
 * scoped to the caller's organizationId; password hashes are never returned.
 */
@Injectable()
export class OrganizationService {
  constructor(
    private readonly repository: OrganizationRepository,
    private readonly eventBus: EventBusService,
    private readonly prisma: PrismaService,
  ) {}

  async getCurrent(organizationId: string): Promise<Organization> {
    const org = await this.repository.findById(organizationId);
    if (!org) {
      throw new NotFoundException('Organization', organizationId);
    }
    return org;
  }

  async updateCurrent(
    organizationId: string,
    actorId: string,
    input: UpdateOrganizationInput,
  ): Promise<Organization> {
    await this.getCurrent(organizationId);
    const data: Prisma.OrganizationUpdateInput = {
      name: input.name,
      description: input.description,
      logo: input.logo,
      plan: input.plan,
    };
    const org = await this.repository.update(organizationId, data);
    await this.eventBus.emit(
      DomainEventName.OrganizationUpdated,
      { organizationId },
      { organizationId, actorId, aggregateType: 'organization', aggregateId: organizationId },
    );
    return org;
  }

  async listMembers(organizationId: string, query: PaginationQuery) {
    const where: Prisma.UserWhereInput = { organizationId, deletedAt: null };
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const pagination = toPrismaPagination(query, MEMBER_SORTABLE);
    const { items, total } = await this.repository.findMembersAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query.page, query.limit));
  }

  async inviteMember(organizationId: string, actorId: string, input: InviteMemberInput) {
    const email = input.email.toLowerCase();
    // Email is globally unique; check across all orgs for a clean error.
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }
    const member = await this.repository.createMember({
      organization: { connect: { id: organizationId } },
      name: input.name,
      email,
      role: input.role,
      status: UserStatus.INVITED,
    });
    await this.eventBus.emit(
      DomainEventName.UserInvited,
      { userId: member.id, email: member.email, role: member.role },
      { organizationId, actorId, aggregateType: 'user', aggregateId: member.id },
    );
    return member;
  }

  async updateMember(
    organizationId: string,
    actorId: string,
    memberId: string,
    input: UpdateMemberInput,
  ) {
    const target = await this.repository.findMemberById(organizationId, memberId);
    if (!target) {
      throw new NotFoundException('Member', memberId);
    }

    // Guard: never demote the last remaining OWNER of the organization.
    const demotingOwner =
      target.role === UserRole.OWNER && input.role && input.role !== UserRole.OWNER;
    const suspendingOwner =
      target.role === UserRole.OWNER &&
      input.status &&
      input.status !== UserStatus.ACTIVE;
    if (demotingOwner || suspendingOwner) {
      const owners = await this.repository.countOwners(organizationId);
      if (owners <= 1) {
        throw new ForbiddenException('Cannot change the role or status of the last owner');
      }
    }

    const member = await this.repository.updateMember(memberId, {
      role: input.role,
      status: input.status,
    });
    await this.eventBus.emit(
      DomainEventName.UserUpdated,
      { userId: memberId, role: input.role, status: input.status },
      { organizationId, actorId, aggregateType: 'user', aggregateId: memberId },
    );
    return member;
  }

  async removeMember(organizationId: string, actorId: string, memberId: string) {
    if (memberId === actorId) {
      throw new ForbiddenException('You cannot remove yourself');
    }
    const target = await this.repository.findMemberById(organizationId, memberId);
    if (!target) {
      throw new NotFoundException('Member', memberId);
    }
    if (target.role === UserRole.OWNER) {
      const owners = await this.repository.countOwners(organizationId);
      if (owners <= 1) {
        throw new ForbiddenException('Cannot remove the last owner');
      }
    }
    await this.repository.softDeleteMember(memberId);
    await this.eventBus.emit(
      DomainEventName.UserRemoved,
      { userId: memberId },
      { organizationId, actorId, aggregateType: 'user', aggregateId: memberId },
    );
    return { id: memberId, removed: true };
  }

  /**
   * Rotates the organization's admin API key (owners only — enforced by
   * @Roles(OWNER) at the controller). Every currently active admin key is
   * revoked and a single fresh admin key is minted. Only the SHA-256 hash of
   * the new key is persisted; the raw secret is returned to the caller exactly
   * once. An immutable DomainEvent is emitted on completion, which the audit
   * listener also records as an AuditLog row.
   */
  async rotateKeys(organizationId: string, actorId: string, input: RotateKeysInput) {
    // Guards against deleted/missing orgs and keeps the event aggregate valid.
    await this.getCurrent(organizationId);

    const activeKeys = await this.repository.findActiveApiKeys(organizationId);
    const adminKeys = activeKeys.filter((key) =>
      key.permissions.some((permission) => permission.toLowerCase() === 'admin'),
    );

    // Supersede every active admin key — rotation must leave no old key valid.
    for (const key of adminKeys) {
      await this.repository.revokeApiKey(key.id);
    }

    const { raw, prefix, hashedKey } = generateApiKey('live');
    const apiKey = await this.repository.createApiKey({
      organizationId,
      createdById: actorId,
      name: input.name ?? 'Admin API key',
      prefix,
      hashedKey,
      permissions: ['admin'],
      allowedIps: [],
    });

    await this.eventBus.emit(
      DomainEventName.OrganizationKeyRotated,
      {
        keyId: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.prefix,
        revokedCount: adminKeys.length,
        reason: input.reason ?? null,
      },
      { organizationId, actorId, aggregateType: 'organization', aggregateId: organizationId },
    );

    // The raw secret is shown exactly once and never stored or logged.
    return {
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      permissions: apiKey.permissions,
      revokedCount: adminKeys.length,
      key: raw,
    };
  }
}
