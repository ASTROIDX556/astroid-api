import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiParam,
  ApiQuery,
  ApiProduces,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import {
  ApiPageOrCursorPaginatedEnvelope,
  ApiCursorPaginatedEnvelope,
  ApiEnvelope,
} from '../../common/decorators/api-envelope.decorator';
import { ApiPaginationQuery } from '../../common/decorators/api-pagination-query.decorator';
import { UserRole } from '@prisma/client';
import { Response } from 'express';
import { AuditService } from './audit.service';
import { AuditArchiveService } from './audit-archive.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  AuditArchiveBatchListDto,
  AuditArchiveRecordListDto,
} from './audit-archive.dto';
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
import {
  AuditTimelineQuery,
  auditResourceIdParamSchema,
  auditTimelineQuerySchema,
} from './audit-timeline.dto';
import { ApiAuthenticated } from '../../common/decorators/api-authenticated.decorator';

/** Read-only access to the append-only audit trail. Restricted to auditors/admins. */
@ApiTags('audit')
@ApiAuthenticated()
@Controller('audit')
@Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.AUDITOR)
@ApiErrorResponses({ unauthorized: true, forbidden: true, tooManyRequests: true, serverError: true })
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly auditArchiveService: AuditArchiveService,
  ) {}

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
      'Returns audit log entries of the authenticated organization, always ordered by `createdAt DESC, id DESC`. ' +
      '`id` breaks ties between entries that share a timestamp, so pages never skip or repeat rows. ' +
      'Pass `cursor` from `meta.nextCursor` for stable keyset pagination; page/offset mode is kept for backwards compatibility and uses the same order. ' +
      '`actorId`, `action`, `resourceType` and `resourceId` are exact, case-sensitive matches (no partial or fuzzy matching); ' +
      '`from`/`to` bound `createdAt` inclusively and `from` must not be later than `to`. ' +
      'Filters only narrow the organization-scoped result set; unknown query parameters are rejected with 400.',
  })
  @ApiPaginationQuery()
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque keyset cursor from meta.nextCursor' })
  @ApiQuery({ name: 'actorId', required: false, type: String, description: 'Exact match on the id of the acting user (stored as `userId`), 1-128 characters' })
  @ApiQuery({ name: 'action', required: false, type: String, description: 'Exact match on the audit action, e.g. `transaction.created`, 1-120 characters' })
  @ApiQuery({ name: 'resourceType', required: false, type: String, description: 'Exact match on the affected entity type (stored as `entity`), 1-120 characters' })
  @ApiQuery({ name: 'resourceId', required: false, type: String, description: 'Exact match on the affected entity id (stored as `entityId`), 1-128 characters' })
  @ApiQuery({ name: 'outcome', required: false, enum: ['SUCCESS', 'FAILURE'], description: 'Filter by the derived result of the audited operation' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Case-insensitive search over action, entity, entityId and requestId' })
  @ApiQuery({
    name: 'from',
    required: false,
    schema: { type: 'string', format: 'date-time', example: '2026-09-01T00:00:00.000Z' },
    description: 'Inclusive ISO 8601 start of the range (`createdAt >= from`). Must not be later than `to`, otherwise 400',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    schema: { type: 'string', format: 'date-time', example: '2026-09-30T23:59:59.999Z' },
    description: 'Inclusive ISO 8601 end of the range (`createdAt <= to`). Must not be earlier than `from`, otherwise 400',
  })
  @ApiPageOrCursorPaginatedEnvelope(AuditLogEntryDto, {
    description: 'Paginated list of audit log entries',
  })
  @ApiErrorResponses({
    validation: 'Malformed cursor or invalid filter',
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

  @Get('resources/:resourceId/timeline')
  @ApiOperation({
    summary: 'List the audit timeline for a resource',
    description:
      'Returns every audit entry for one resource id in ascending creation order. Uses the same opaque `(createdAt, id)` cursor as the audit listing, with the comparison direction inverted.',
  })
  @ApiParam({ name: 'resourceId', description: 'Affected entity id whose timeline is requested' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque keyset cursor from meta.nextCursor' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size, bounded by AUDIT_PAGE_SIZE_MAX' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'Inclusive ISO 8601 start of the range' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'Inclusive ISO 8601 end of the range' })
  @ApiCursorPaginatedEnvelope(AuditLogEntryDto, {
    description: 'Ascending audit timeline for the requested resource',
  })
  @ApiErrorResponses({
    validation: 'Malformed cursor or invalid filter',
    unauthorized: true,
    forbidden: true,
    serverError: true,
  })
  timeline(
    @CurrentUser('organizationId') organizationId: string,
    @Param('resourceId', new ZodValidationPipe(auditResourceIdParamSchema)) resourceId: string,
    @Query(new ZodValidationPipe(auditTimelineQuerySchema)) query: AuditTimelineQuery,
  ) {
    return this.auditService.timeline(organizationId, resourceId, query);
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

  @Get('archives')
  @ApiOperation({
    summary: 'List the audit archives of the organization',
    description:
      'Lists the batches of audit records that the archival job moved out of the actively queried `audit_logs` table. ' +
      'Only the batch metadata is returned; use `GET /audit/archives/{batchId}` to read the records of a batch.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max batches to return (default 50, max 100)' })
  @ApiEnvelope(AuditArchiveBatchListDto, { description: 'Archive batches, newest first' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, serverError: true })
  async listArchives(
    @CurrentUser('organizationId') organizationId: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    const batches = await this.auditArchiveService.listArchives(
      organizationId,
      Number.isFinite(parsed) && parsed > 0 ? parsed : 50,
    );
    return { batches, count: batches.length };
  }

  @Get('archives/:batchId')
  @ApiOperation({
    summary: 'Read the records of an audit archive batch',
    description:
      'Returns the audit records of one archived batch. The compressed payload is decompressed and its checksum verified before it is returned.',
  })
  @ApiParam({ name: 'batchId', description: 'Archive batch id', example: '8f1c…' })
  @ApiEnvelope(AuditArchiveRecordListDto, { description: 'The archived audit records' })
  @ApiErrorResponses({ unauthorized: true, forbidden: true, notFound: true, serverError: true })
  async readArchive(
    @CurrentUser('organizationId') organizationId: string,
    @Param('batchId') batchId: string,
  ) {
    const records = await this.auditArchiveService.readArchive(organizationId, batchId);
    return { records, count: records.length };
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
