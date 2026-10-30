import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import type { UserRepository } from './user-repository';
import { ApiError } from '../../common/api-error';

export type AuthRequest = Request & { userId: number };

export const UserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthRequest>().userId,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(User) private readonly users: UserRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (req.method === 'OPTIONS' || ['/api/auth/login', '/api/auth/register'].includes(req.path))
      return true;
    try {
      if (!req.headers.authorization?.startsWith('Bearer ')) throw new Error();
      const claims = this.jwt.verify(req.headers.authorization.slice(7), { algorithms: ['HS256'] });
      if (
        !Number.isSafeInteger(claims.userId) ||
        !(await this.users.findOneBy({ id: claims.userId }))
      )
        throw new Error();
      req.userId = claims.userId;
      return true;
    } catch {
      throw new ApiError(401, '未登录或登录已过期');
    }
  }
}
