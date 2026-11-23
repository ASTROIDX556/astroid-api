import { Injectable } from '@nestjs/common';
import { Agent, AgentStatus, Prisma } from '@prisma/client';
import { AgentRepository } from './agent.repository';
import { AssignWalletInput, CreateAgentInput, UpdateAgentInput } from './agent.dto';
import { ConflictException, NotFoundException } from '../../common/exceptions/domain.exception';
import {
  cursorWhere,
  paginatePage,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/pagination';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';


/**
 * Manages the lifecycle of autonomous agents: registration, updates, status
 * transitions (pause/reactivate/suspend) and primary-wallet assignment.
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly repository: AgentRepository,
    private readonly eventBus: EventBusService,
  ) {}

  async create(organizationId: string, actorId: string, input: CreateAgentInput) {
    const agent = await this.repository.create({
      organization: { connect: { id: organizationId } },
      name: input.name,
      description: input.description,
      provider: input.provider,
      model: input.model,
      role: input.role,
      capabilities: input.capabilities,
      metadata: input.metadata as Prisma.InputJsonValue,
    });
    await this.eventBus.emit(
      DomainEventName.AgentRegistered,
      { agentId: agent.id, name: agent.name, role: agent.role },
      { organizationId, actorId, aggregateType: 'agent', aggregateId: agent.id },
    );
    return agent;
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.AgentWhereInput = { organizationId, deletedAt: null };
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    if (query.filter) {
      where.status = query.filter as AgentStatus;
    }
    const pagination = toPrismaPagination(query);
    const { items, total } = await this.repository.findManyAndCount(
      { ...where, ...cursorWhere(query.cursor) },
      pagination,
    );
    return paginatePage(items, total, query);
  }

  async getOrThrow(organizationId: string, id: string): Promise<Agent> {
    const agent = await this.repository.findById(organizationId, id);
    if (!agent) {
      throw new NotFoundException('Agent', id);
    }
    return agent;
  }

  async update(organizationId: string, actorId: string, id: string, input: UpdateAgentInput) {
    await this.getOrThrow(organizationId, id);
    const data: Prisma.AgentUpdateInput = {
      name: input.name,
      description: input.description,
      provider: input.provider,
      model: input.model,
      role: input.role,
      capabilities: input.capabilities,
    };
    if (input.metadata) {
      data.metadata = input.metadata as Prisma.InputJsonValue;
    }
    const agent = await this.repository.update(id, data);
    await this.eventBus.emit(
      DomainEventName.AgentUpdated,
      { agentId: id },
      { organizationId, actorId, aggregateType: 'agent', aggregateId: id },
    );
    return agent;
  }

  /** Transitions an agent's status, emitting the matching lifecycle event. */
  async setStatus(organizationId: string, actorId: string, id: string, status: AgentStatus) {
    await this.getOrThrow(organizationId, id);
    const agent = await this.repository.update(id, { status });
    const event =
      status === AgentStatus.ACTIVE
        ? DomainEventName.AgentReactivated
        : DomainEventName.AgentSuspended;
    await this.eventBus.emit(
      event,
      { agentId: id, status },
      { organizationId, actorId, aggregateType: 'agent', aggregateId: id },
    );
    return agent;
  }

  async remove(organizationId: string, actorId: string, id: string) {
    await this.getOrThrow(organizationId, id);
    await this.repository.softDelete(id);
    await this.eventBus.emit(
      DomainEventName.AgentSuspended,
      { agentId: id, archived: true },
      { organizationId, actorId, aggregateType: 'agent', aggregateId: id },
    );
    return { id, archived: true };
  }

  /** Assigns a wallet as the agent's primary wallet (must be in the same org). */
  async assignWallet(
    organizationId: string,
    actorId: string,
    id: string,
    input: AssignWalletInput,
  ) {
    await this.getOrThrow(organizationId, id);
    const wallet = await this.repository.findWalletInOrg(organizationId, input.walletId);
    if (!wallet) {
      throw new NotFoundException('Wallet', input.walletId);
    }
    if (wallet.agentId && wallet.agentId !== id) {
      throw new ConflictException('Wallet is already owned by another agent');
    }
    const agent = await this.repository.update(id, {
      primaryWallet: { connect: { id: input.walletId } },
    });
    await this.eventBus.emit(
      DomainEventName.AgentWalletAssigned,
      { agentId: id, walletId: input.walletId },
      { organizationId, actorId, aggregateType: 'agent', aggregateId: id },
    );
    return agent;
  }
}
