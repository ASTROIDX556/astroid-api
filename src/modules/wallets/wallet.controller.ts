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
import { UserRole, WalletStatus } from '@prisma/client';
import { WalletService } from './wallet.service';
import {
  createWalletSchema,
  CreateWalletInput,
  updateWalletSchema,
  UpdateWalletInput,
} from './wallet.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/pagination';

@ApiTags('wallets')
@Controller('wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @ApiOperation({ summary: 'List wallets' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.walletService.list(organizationId, query);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE, UserRole.DEVELOPER)
  @ApiOperation({
    summary: 'Create a wallet (generate a keypair or import an address)',
    description:
      'When generating, the secret key is returned exactly once and never stored server-side.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletInput,
  ) {
    return this.walletService.create(user.organizationId, user.id, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a wallet' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.walletService.getOrThrow(organizationId, id);
  }

  @Get(':id/balances')
  @ApiOperation({ summary: 'Fetch live on-chain balances for a wallet' })
  balances(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.walletService.getBalances(organizationId, id);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE, UserRole.DEVELOPER)
  @ApiOperation({ summary: 'Update a wallet label or owning agent' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateWalletSchema)) body: UpdateWalletInput,
  ) {
    return this.walletService.update(user.organizationId, user.id, id, body);
  }

  @Post(':id/freeze')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Freeze a wallet (block outgoing transactions)' })
  freeze(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.walletService.setStatus(user.organizationId, user.id, id, WalletStatus.FROZEN);
  }

  @Post(':id/unfreeze')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Unfreeze a wallet' })
  unfreeze(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.walletService.setStatus(user.organizationId, user.id, id, WalletStatus.ACTIVE);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Archive (soft-delete) a wallet' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.walletService.remove(user.organizationId, user.id, id);
  }
}
