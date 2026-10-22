import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiProduces,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import { UserRole } from '@prisma/client';
import { Response } from 'express';
import { AuditService } from './audit.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  ExportAuditLogsQuery,
  exportAuditLogsQuerySchema,
  ExportAuditLogsQueryDto,
  StreamAuditLogsQuery,
  streamAuditLogsQuerySchema,
  StreamAuditLogsQueryDto,
} from './audit-export.dto';
import { AuditListQuery, auditListQuerySchema } from './audit-list.dto';
import { AuditLogEntryDto, AuditExportDto, AuditIntegrityDto } from './audit-list.dto';

/** Read-only access to the append-only audit trail. Restricted to auditors/admins. */
@ApiTags('audit')
@ApiBearerAuth('access-token')
@Controller('audit')
@Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.AUDITOR)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('export')
  @ApiOperation({
    summary: 'Export audit log entries for compliance reporting',
    description:
      'Exports audit log entries in CSV or JSON format. Supports filtering by action, date range, and agent.',
  })
  @ApiQuery({ type: ExportAuditLogsQueryDto })
  @ApiProduces('text/csv', 'application/json')
  @ApiEnvelope(AuditExportDto, { description: 'Audit log export (CSV or JSON)' })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: 'Insufficient permissions (requires OWNER, ADMIN, or AUDITOR)',
    serverError: true,
  })
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
  @ApiOperation({
    summary: 'List audit log entries for the organization',
    description:
      'Returns a cursor-paginated list of audit log entries, newest first. Supports filtering by actor, action, resource and date range.',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque pagination cursor from a previous page' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max entries to return (default 20, max 100)' })
  @ApiQuery({ name: 'actorId', required: false, type: String, description: 'Filter by acting user UUID' })
  @ApiQuery({ name: 'action', required: false, type: String, description: 'Filter by audit action type' })
  @ApiQuery({ name: 'resourceId', required: false, type: String, description: 'Filter by affected entity UUID' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO 8601 start of the date range' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO 8601 end of the date range' })
  @ApiEnvelope(AuditLogEntryDto, {
    isArray: true,
    description: 'Cursor-paginated list of audit log entries',
  })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: true,
    serverError: true,
  })
  list(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(auditListQuerySchema)) query: AuditListQuery,
  ) {
    return this.auditService.list(organizationId, query);
  }

  @Get('export/stream')
  @ApiOperation({
    summary: 'Stream audit log entries for large compliance exports',
    description:
      'Streams audit log entries in bounded batches (CSV or JSON) without loading the full result set into memory.',
  })
  @ApiQuery({ type: StreamAuditLogsQueryDto })
  @ApiProduces('text/csv', 'application/json')
  @ApiEnvelope(AuditExportDto, { description: 'Streamed audit log export (CSV or JSON)' })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: 'Insufficient permissions (requires OWNER, ADMIN, or AUDITOR)',
    serverError: true,
  })
  async streamExport(
    @CurrentUser('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(streamAuditLogsQuerySchema)) query: StreamAuditLogsQuery,
    @Res() res: Response,
  ) {
    res.setHeader(
      'Content-Type',
      query.format === 'csv' ? 'text/csv' : 'application/json',
    );
    if (query.format === 'csv') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audit-logs-${organizationId}-${Date.now()}.csv"`,
      );
    }
    for await (const chunk of this.auditService.streamExport(organizationId, query)) {
      res.write(chunk);
    }
    res.end();
  }

  @Get('integrity/verify')
  @ApiOperation({
    summary: 'Verify the integrity of the entire audit chain',
    description:
      'Performs a cryptographic verification of the entire audit chain to detect any tampering. ' +
      'This operation may be slow for large audit logs.',
  })
  @ApiEnvelope(AuditIntegrityDto, {
    description: 'Integrity verification result (valid/invalid with details)',
  })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: true,
    serverError: true,
  })
  verifyIntegrity(@CurrentUser('organizationId') organizationId: string) {
    return this.auditService.verifyIntegrity(organizationId);
  }

  @Get('integrity/:id')
  @ApiOperation({
    summary: 'Verify the integrity of a single audit log entry',
    description:
      'Verifies that a specific audit log entry has not been tampered with by checking its cryptographic hash.',
  })
  @ApiParam({ name: 'id', description: 'Audit log entry UUID', example: '018f0a1b-...' })
  @ApiEnvelope(AuditIntegrityDto, { description: 'Entry integrity verification result' })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: true,
    notFound: true,
    serverError: true,
  })
  verifyEntryIntegrity(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
  ) {
    return this.auditService.verifyEntryIntegrity(id, organizationId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a single audit log entry',
    description: 'Returns full details of a single audit log entry by ID.',
  })
  @ApiParam({ name: 'id', description: 'Audit log entry UUID', example: '018f0a1b-...' })
  @ApiEnvelope(AuditLogEntryDto, { description: 'Audit log entry details' })
  @ApiErrorResponses({
    unauthorized: true,
    forbidden: true,
    notFound: true,
    serverError: true,
  })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.auditService.findById(organizationId, id);
  }
}
