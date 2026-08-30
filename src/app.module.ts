import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { AppConfigModule } from './config';
import { QueueConfig } from './config/queue.config';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { RequestIdMiddleware } from './middleware/request-id.middleware';
import { REQUEST_ID_HEADER } from './common/constants/headers';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ScopesGuard } from './common/guards/scopes.guard';
import { AstroidThrottlerGuard } from './common/guards/throttler.guard';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

import { AuthModule } from './modules/auth/auth.module';
import { OrganizationModule } from './modules/organizations/organization.module';
import { AgentModule } from './modules/agents/agent.module';
import { WalletModule } from './modules/wallets/wallet.module';
import { PolicyModule } from './modules/policies/policy.module';
import { RiskModule } from './modules/risk/risk.module';
import { BudgetModule } from './modules/budgets/budget.module';
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
import { AgentTraceInterceptor } from './common/interceptors/agent-trace.interceptor';

/**
 * Root application module. Wires the global infrastructure (config, logging,
 * database, events, rate limiting) and every domain module, then registers the
 * cross-cutting guards, interceptor and exception filter that enforce the
 * platform's contract on every request:
 *   - JwtAuthGuard      : authentication on all routes except @Public()
 *   - RolesGuard        : RBAC on routes decorated with @Roles()
 *   - ScopesGuard       : Fine-grained permission scopes for API keys & agents
 *   - ThrottlerGuard    : per-organization / per-IP rate limiting
 *   - ResponseInterceptor: wraps every result in the success envelope
 *   - AllExceptionsFilter: converts every error into the error envelope
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        // Reuse the request id set by RequestIdMiddleware for correlated logs.
        genReqId: (req) => (req.headers[REQUEST_ID_HEADER] as string) ?? undefined,
        // Never log Authorization headers, cookies or API keys.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
          ],
          remove: true,
        },
        autoLogging: true,
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
      },
    }),
    // Two rate-limit tiers, both driven by THROTTLE_* env vars. Every route is
    // subject to both named throttlers, but AstroidThrottlerGuard enforces only
    // the one matching the route's @ThrottleTierDecorator tier ('api' default,
    // 'auth' for the sensitive auth endpoints).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { throttle } = config.getOrThrow<QueueConfig>('queue');
        const ttl = throttle.ttl * 1000; // seconds → milliseconds
        return [
          { name: 'api', ttl, limit: throttle.apiLimit },
          { name: 'auth', ttl, limit: throttle.authLimit },
        ];
      },
    }),

    DatabaseModule,
    EventsModule,

    // Domain modules
    AuthModule,
    OrganizationModule,
    AgentModule,
    WalletModule,
    PolicyModule,
    RiskModule,
    BudgetModule,
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
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
    { provide: APP_GUARD, useClass: AstroidThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AgentTraceInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
