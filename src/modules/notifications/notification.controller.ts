import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import { markReadSchema, MarkReadInput } from './notification.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/pagination';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'List the current user notifications' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.notificationService.list(user.organizationId, user.id, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Count unread notifications' })
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationService.unreadCount(user.organizationId, user.id);
  }

  @Post('read')
  @ApiOperation({ summary: 'Mark specific notifications as read' })
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(markReadSchema)) body: MarkReadInput,
  ) {
    return this.notificationService.markRead(user.organizationId, user.id, body.ids);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationService.markAllRead(user.organizationId, user.id);
  }
}
