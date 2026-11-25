import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { Redis } from 'ioredis';

import { AppConfigModule } from './config';
import { createThrottlerOptions, ThrottlerConfig } from './config/throttler.config';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { LocksModule } from './common/locks/locks.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { ShutdownModule } from './common/shutdown/shutdown.module';
import { REDIS_CLIENT } from './common/locks/locks.constants';
import { EncryptionModule } from './common/encryption/encryption.module';
import { RequestIdMiddleware } from './middleware/request-id.middleware';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { StructuredRequestLoggingMiddleware } from './middleware/structured-request-logging.middleware';
import { RawBodyMiddleware } from './common/middleware/raw-body.middleware';
import { createPinoHttpOptions } from './common/logging/pino-http.options';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ScopesGuard } from './common/guards/scopes.guard';
import { AstroidThrottlerGuard } from './common/guards/throttler.guard';
import { PublicRateLimitGuard } from './common/guards/public-rate-limit.guard';
import { CredentialRateLimitGuard } from './common/guards/credential-rate-limit.guard';
import { CredentialQuotaCache } from './common/throttler/credential-quota';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { ZodValidationExceptionFilter } from './common/filters/zod-validation-exception.filter';
import { AgentPolicyGuard } from './modules/policies/guards/agent-policy.guard';

import { AuthModule } from './modules/auth/auth.module';
import { OrganizationModule } from './modules/organizations/organization.module';
import { AgentModule } from './modules/agents/agent.module';
import { WalletModule } from './modules/wallets/wallet.module';
import { WalletReconciliationModule } from './modules/wallets/wallet-reconciliation.module';
import { PolicyModule } from './modules/policies/policy.module';
import { RiskModule } from './modules/risk/risk.module';
import { BudgetModule } from './modules/budgets/budget.module';
import { BudgetRolloverModule } from './modules/budgets/budget-rollover.module';
import { TransactionModule } from './modules/transactions/transaction.module';
import { ApprovalModule } from './modules/approvals/approval.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { NotificationModule } from './modules/notifications/notification.module';
import { DeveloperModule } from './modules/developer/developer.module';
import { MemoryModule } from './modules/memory/memory.module';
import { WebhookModule } from './modules/webhooks/webhook.module';
import { StellarModule } from './modules/stellar/stellar.module';
import { AuditModule } from './modules/audit/audit.module';
import { AiModule } from './modules/ai/ai.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { AdminModule } from './modules/admin/admin.module';
import { DeadLetterModule } from './modules/dead-letter/dead-letter.module';
import { QueueObservabilityModule } from './modules/queue-observability/queue-observability.module';
import { AgentTraceInterceptor } from './common/interceptors/agent-trace.interceptor';
import { RequestContextInterceptor } from './common/interceptors/request-context.interceptor';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { StructuredAuditInterceptor } from './common/interceptors/structured-audit.interceptor';
import { MetricsInterceptor } from './common/interceptors/metrics.interceptor';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';

/**
 * Root application module. Wires the global infrastructure (config, logging,
 * database, events, rate limiting) and every domain module, then registers the
 * cross-cutting guards, interceptor and exception filter that enforce the
 * platform's contract on every request:
 *   - PublicRateLimitGuard: per-IP sliding-window limit on @Public() routes and
 *                          /<prefix>/public/*, shared via Redis (runs first so
 *                          bursts are rejected before any other work)
 *   - JwtAuthGuard      : authentication on all routes except @Public()
 *   - RolesGuard        : RBAC on routes decorated with @Roles()
 *   - ScopesGuard       : Fine-grained permission scopes for API keys & agents
 *   - ThrottlerGuard    : per-organization / per-IP rate limiting, shared via Redis
 *   - CredentialRateLimitGuard: per-credential minute/day quota with plain
 *                          X-RateLimit-* headers, keyed by the verified API key
 *                          (runs after authentication; falls back to user/IP)
 *   - ResponseInterceptor: wraps every result in the success envelope
 *   - AuditLogInterceptor: persists masked mutation requests to the audit trail
 *   - StructuredAuditInterceptor: publishes `audit.recorded` events for every
 *                          route marked with @AuditAction() so sensitive
 *                          operations are logged asynchronously on the event bus
 *   - MetricsInterceptor: records Prometheus metrics for HTTP requests
 *   - AllExceptionsFilter: converts every error into the error envelope
 */
@Module({
  imports: [
    AppConfigModule,
    // Redaction of credentials and secrets is configured once, at the logger
    // (see common/logging/pino-http.options.ts and docs/security-redaction.md).
    LoggerModule.forRoot({ pinoHttp: createPinoHttpOptions() }),
    // Three rate-limit tiers, all driven by THROTTLE_* env vars (see
    // config/throttler.config.ts). Every route is subject to all named
    // throttlers, but AstroidThrottlerGuard enforces only the one matching the
    // route's @ThrottleTierDecorator tier ('api' default, 'auth' for the
    // sensitive auth endpoints), and AgentThrottlerGuard (applied to the
    // agent-facing controllers) enforces the 'agent' tier keyed by acting agent.
    // Counters live in Redis so every replica behind the load balancer enforces
    // the same budget.
    ThrottlerModule.forRootAsync({
      imports: [LocksModule],
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (config: ConfigService, redis: Redis) =>
        createThrottlerOptions(
          config.getOrThrow<ThrottlerConfig>('throttler'),
          new RedisThrottlerStorage(redis),
        ),
    }),

    ShutdownModule,
    DatabaseModule,
    EventsModule,
    LocksModule,
    IdempotencyModule,
    EncryptionModule,

    // Domain modules
    AuthModule,
    OrganizationModule,
    AgentModule,
    WalletModule,
    WalletReconciliationModule,
    PolicyModule,
    RiskModule,
    BudgetModule,
    BudgetRolloverModule,
    TransactionModule,
    ApprovalModule,
    AnalyticsModule,
    NotificationModule,
    DeveloperModule,
    MemoryModule,
    WebhookModule,
    StellarModule,
    AuditModule,
    AiModule,
    HealthModule,
    MetricsModule,
    DeadLetterModule,
    AdminModule,
    QueueObservabilityModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: PublicRateLimitGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
    { provide: APP_GUARD, useClass: AstroidThrottlerGuard },
    CredentialQuotaCache,
    { provide: APP_GUARD, useClass: CredentialRateLimitGuard },
    AgentPolicyGuard,
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AgentTraceInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: StructuredAuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_FILTER, useClass: ZodValidationExceptionFilter },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware, RequestIdMiddleware, StructuredRequestLoggingMiddleware)
      .forRoutes('*');
    consumer.apply(RawBodyMiddleware).forRoutes({
      path: 'webhooks/receive',
      method: RequestMethod.POST,
    });
  }
}
