import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from 'helmet';
import { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { ShutdownCoordinator } from './common/shutdown/shutdown-coordinator.service';
import { AppConfig } from './config/app.config';
import {
  RATE_LIMIT_LIMIT_HEADER,
  RATE_LIMIT_REMAINING_HEADER,
  RATE_LIMIT_RESET_HEADER,
  RETRY_AFTER_HEADER,
  TOTAL_COUNT_HEADER,
} from './common/constants/headers';
import { GLOBAL_PREFIX_EXCLUDED_ROUTES } from './common/constants/global-prefix';
import { buildSwaggerConfig } from './common/openapi/swagger-config';
import { assertValidEnvironment, EnvironmentValidationError } from './config/env.validation';
import { PrismaService } from './database/prisma.service';
import { configureSensitiveFields } from './common/helpers/audit-sanitizer';

async function bootstrap() {
  // Fail fast on missing or malformed configuration, before any module is
  // constructed or any connection is opened. `.env` has already been merged
  // into `process.env` at this point: `ConfigModule.forRoot` loads it when
  // `AppModule` is imported.
  const environment = assertValidEnvironment(process.env);
  // Deployment-specific redaction keys, applied before the logger is built.
  configureSensitiveFields(environment.LOG_REDACT_FIELDS);

  // `NestFactory.create` awaits every module's `onModuleInit`, and
  // `PrismaService.onModuleInit` connects and then unconditionally validates
  // that every migration shipped with this build has been applied — a
  // pending or failed migration throws there, so `create` rejects and the
  // process exits before accepting any traffic.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  const config = app.get(ConfigService);
  const appConfig = config.getOrThrow<AppConfig>('app');
  const prisma = app.get(PrismaService);

  // Structured logging (nestjs-pino)
  app.useLogger(app.get(PinoLogger));

  // Configurable boot-time migration gate (DATABASE_MIGRATION_CHECK): in
  // strict mode (the production default) this throws and aborts startup
  // before any route is served; in warn mode it only logs; off skips it.
  await prisma.verifyMigrations();

  // Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
  // Referrer-Policy). Swagger UI — served only outside production — needs inline
  // styles/scripts, so CSP is relaxed there and kept at helmet's strict default
  // in production.
  const isProduction = appConfig.nodeEnv === 'production';
  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? undefined
        : {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
            },
          },
      hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // Permissions-Policy is not part of helmet's defaults; disable powerful
  // browser features the API never uses.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    );
    next();
  });

  // CORS. X-Total-Count is exposed so browser clients can read the total row
  // count of paginated list responses.
  app.enableCors({
    origin: appConfig.corsOrigins,
    credentials: true,
    exposedHeaders: [
      TOTAL_COUNT_HEADER,
      RATE_LIMIT_LIMIT_HEADER,
      RATE_LIMIT_REMAINING_HEADER,
      RATE_LIMIT_RESET_HEADER,
      RETRY_AFTER_HEADER,
    ],
  });

  // Global validation pipe (transforms + validates DTOs)
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // API prefix (e.g. api/v1). Versioning is expressed via this stable prefix
  // rather than Nest URI versioning to avoid a duplicated version segment.
  // `/metrics` and the liveness/readiness probes stay at fixed, unversioned
  // paths; the list is shared with the OpenAPI check (see global-prefix.ts).
  app.setGlobalPrefix(appConfig.apiPrefix, { exclude: GLOBAL_PREFIX_EXCLUDED_ROUTES });

  // OpenAPI / Swagger documentation
  if (appConfig.nodeEnv !== 'production') {
    const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
    SwaggerModule.setup('docs', app, document);
  }

  app.enableShutdownHooks();

  await app.listen(appConfig.port);

  // Graceful shutdown on SIGTERM / SIGINT: stop accepting HTTP work, drain
  // in-flight requests and BullMQ jobs within SHUTDOWN_GRACE_PERIOD_MS, then
  // close queues, Redis and Prisma in order. Used instead of Nest's
  // app.enableShutdownHooks(), which disconnects the database before the HTTP
  // server stops and has no grace period; the coordinator still runs every
  // Nest lifecycle hook through app.close().
  app.get(ShutdownCoordinator).enableShutdownHooks(app);
  console.log(`🚀 Astroid API listening on port ${appConfig.port}`);
  console.log(`📚 Swagger docs: http://localhost:${appConfig.port}/docs`);
}

bootstrap().catch((error) => {
  if (error instanceof EnvironmentValidationError) {
    // The message already lists every failing variable; a stack trace would
    // only bury it.
    console.error(error.message);
  } else {
    console.error('Failed to bootstrap:', error);
  }
  process.exit(1);
});
