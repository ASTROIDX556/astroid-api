import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/** Persistence for Organization and User (member) rows. */
@Injectable()
export class OrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.organization.findFirst({ where: { id, deletedAt: null } });
  }

  update(id: string, data: Prisma.OrganizationUpdateInput) {
    return this.prisma.organization.update({ where: { id }, data });
  }

  async findMembersAndCount(where: Prisma.UserWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        ...pagination,
        select: {
          id: true,
          organizationId: true,
          name: true,
          email: true,
          avatar: true,
          role: true,
          status: true,
          lastLogin: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total };
  }

  findMemberById(organizationId: string, id: string) {
    return this.prisma.user.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        name: true,
        email: true,
        avatar: true,
        role: true,
        status: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });
  }

  findMemberByEmail(organizationId: string, email: string) {
    return this.prisma.user.findFirst({
      where: { organizationId, email, deletedAt: null },
    });
  }

  createMember(data: Prisma.UserCreateInput) {
    return this.prisma.user.create({
      data,
      select: {
        id: true,
        organizationId: true,
        name: true,
        email: true,
        avatar: true,
        role: true,
        status: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });
  }

  updateMember(id: string, data: Prisma.UserUpdateInput) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        organizationId: true,
        name: true,
        email: true,
        avatar: true,
        role: true,
        status: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });
  }

  softDeleteMember(id: string) {
    return this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'ARCHIVED' },
    });
  }

  countOwners(organizationId: string) {
    return this.prisma.user.count({
      where: { organizationId, role: 'OWNER', deletedAt: null },
    });
  }
}
