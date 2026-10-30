import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { Store } from '../persistence/store';
import { ApiError } from '../common/api-error';

export type AuthRequest = Request & { userId: number };

export const UserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthRequest>().userId,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly store: Store,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (req.method === 'OPTIONS' || ['/api/auth/login', '/api/auth/register'].includes(req.path))
      return true;
    try {
      if (!req.headers.authorization?.startsWith('Bearer ')) throw new Error();
      const claims = this.jwt.verify(req.headers.authorization.slice(7), { algorithms: ['HS256'] });
      if (!Number.isSafeInteger(claims.userId) || !(await this.store.get('users', claims.userId)))
        throw new Error();
      req.userId = claims.userId;
      return true;
    } catch {
      throw new ApiError(401, '未登录或登录已过期');
    }
  }
}
