import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import {
  markReadSchema,
  MarkReadInput,
  MarkReadDto,
  MarkedReadDto,
  NotificationResponseDto,
  UnreadCountDto,
} from './notification.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaginationQuery, paginationQuerySchema } from '../../common/helpers/pagination';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';
import { ApiEnvelope, ApiPaginatedEnvelope } from '../../common/decorators/api-envelope.decorator';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';

@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @ApiOperation({
    summary: 'List the current user notifications',
    description:
      'Returns a paginated list of notifications for the authenticated user. ' +
      'Supports filtering by read status.',
  })
  @ApiPaginationQuery()
  @ApiQuery({ name: 'unread', required: false, type: Boolean, description: 'Filter by unread status' })
  @ApiPaginatedEnvelope(NotificationResponseDto, { description: 'Paginated list of notifications' })
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.notificationService.list(user.organizationId, user.id, query);
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'Count unread notifications',
    description: 'Returns the count of unread notifications for the authenticated user.',
  })
  @ApiEnvelope(UnreadCountDto, { description: 'Unread notification count' })
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationService.unreadCount(user.organizationId, user.id);
  }

  @Post('read')
  @ApiOperation({
    summary: 'Mark specific notifications as read',
    description: 'Marks the specified notification IDs as read for the authenticated user.',
  })
  @ApiBody({ type: MarkReadDto })
  @ApiEnvelope(MarkedReadDto, { description: 'Notifications marked as read' })
  @ApiErrorResponses({
    validation: 'Validation error (invalid notification IDs)',
    unauthorized: true,
    serverError: true,
  })
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(markReadSchema)) body: MarkReadInput,
  ) {
    return this.notificationService.markRead(user.organizationId, user.id, body.ids);
  }

  @Post('read-all')
  @ApiOperation({
    summary: 'Mark all notifications as read',
    description: 'Marks all unread notifications as read for the authenticated user.',
  })
  @ApiEnvelope(MarkedReadDto, { description: 'All notifications marked as read' })
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationService.markAllRead(user.organizationId, user.id);
  }
}
