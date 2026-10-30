import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import type { UserRepository } from './user-repository';
import { ApiError } from '../../common/api-error';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: UserRepository,
    private readonly jwt: JwtService,
  ) {}

  private result(user: User) {
    return {
      token: this.jwt.sign({ userId: user.id, sub: user.username }),
      username: user.username,
    };
  }

  async register(username: string, password: string) {
    if (await this.users.findOneBy({ username }))
      throw new ApiError(500, 'Registration failed: Username already exists');
    try {
      return this.result(
        await this.users.save({
          username,
          password: await hash(password, 10),
          createdAt: new Date(),
        }),
      );
    } catch (e: any) {
      throw new ApiError(500, 'Registration failed: ' + e.message);
    }
  }

  async login(username: string, password: string) {
    const user = await this.users.findOneBy({ username });
    if (!user) throw new ApiError(401, '用户名不存在');
    if (!(await compare(password, user.password))) throw new ApiError(401, '密码错误');
    return this.result(user);
  }

  async changePassword(userId: number, oldPassword: string, newPassword: string) {
    const user = (await this.users.findOneBy({ id: userId }))!;
    if (!(await compare(oldPassword, user.password))) throw new ApiError(400, '原密码错误');
    if (newPassword.length < 6) throw new ApiError(400, '新密码长度不能少于6位');
    await this.users.update(userId, { password: await hash(newPassword, 10) });
    return { message: '密码修改成功' };
  }

  async changeUsername(userId: number, newUsername: string) {
    if (newUsername.trim().length < 2 || newUsername.length > 20)
      throw new ApiError(400, '用户名长度需要在2-20个字符之间');
    const taken = await this.users.findOneBy({ username: newUsername });
    if (taken && taken.id !== userId) throw new ApiError(400, '用户名已被使用');
    try {
      await this.users.update(userId, { username: newUsername });
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') throw new ApiError(400, '用户名已被使用');
      throw error;
    }
    return { message: '用户名修改成功', username: newUsername };
  }
}
