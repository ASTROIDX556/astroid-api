import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import Redis from 'ioredis';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { TokenBlacklistService } from './services/token-blacklist.service';
import { PasskeyController } from './controllers/passkey.controller';
import { PasskeyService } from './services/passkey.service';
import { redisConfig } from '../../config/redis.config';

/**
 * Authentication module. Registers the passport-jwt strategy and a bare
 * JwtModule (per-call secrets are supplied explicitly by AuthService so the
 * access and refresh tokens can use different signing keys). Also provides the
 * Redis client used by the token blacklist, which lets logout / credential
 * rotation invalidate in-flight JWTs before they naturally expire.
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
  ],
  controllers: [AuthController, PasskeyController],
  providers: [
    {
      provide: Redis,
      useFactory: (): Redis => {
        const config = redisConfig();
        return new Redis({
          host: config.host,
          port: config.port,
          password: config.password || undefined,
          db: config.db,
          lazyConnect: true,
        });
      },
    },
    AuthService,
    JwtStrategy,
    PasskeyService,
    TokenBlacklistService,
  ],
  exports: [AuthService, PasskeyService, TokenBlacklistService],
})
export class AuthModule {}