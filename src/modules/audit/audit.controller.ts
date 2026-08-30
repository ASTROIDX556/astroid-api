import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Response } from 'express';
import { AuditService } from './audit.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  PaginationQuery,
  paginationQuerySchema,
} from '../../common/helpers/pagination';
import {
  ExportAuditLogsQuery,
  exportAuditLogsQuerySchema,
} from './audit-export.dto';

/** Read-only access to the append-only audit trail. Restricted to auditors/admins. */
@ApiTags('audit')
@Controller('audit')
@Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.AUDITOR)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('export')
  @ApiOperation({ summary: 'Export audit log entries for compliance reporting' })
  async export(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(exportAuditLogsQuerySchema)) query: ExportAuditLogsQuery,
    @Res() res: Response,
  ) {
    const result = await this.auditService.export(organizationId, query);

    if (result.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audit-logs-${organizationId}-${Date.now()}.csv"`,
      );
      return res.status(200).send(result.data);
    }

    return res.status(200).json({
      success: true,
      data: result.data,
      meta: {
        count: result.count,
        nextCursor: result.nextCursor,
      },
    });
  }

  @Get()
  @ApiOperation({ summary: 'List audit log entries for the organization' })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.auditService.list(organizationId, query);
  }

  @Get('integrity/verify')
  @ApiOperation({ summary: 'Verify the integrity of the entire audit chain' })
  verifyIntegrity(@CurrentUser('organizationId') organizationId: string) {
    return this.auditService.verifyIntegrity(organizationId);
  }

  @Get('integrity/:id')
  @ApiOperation({ summary: 'Verify the integrity of a single audit log entry' })
  verifyEntryIntegrity(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
  ) {
    return this.auditService.verifyEntryIntegrity(id, organizationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single audit log entry' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.auditService.findById(organizationId, id);
  }
}
