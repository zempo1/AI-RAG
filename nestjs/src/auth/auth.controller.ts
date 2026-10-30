import { Body, Controller, Post } from '@nestjs/common';
import { IsString, IsNotEmpty, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { UserId } from './auth.guard';

class Credentials {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  username: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  password: string;
}

class PasswordChange {
  @IsString()
  @IsNotEmpty()
  oldPassword: string;

  @IsString()
  @MinLength(6)
  @MaxLength(72)
  newPassword: string;
}

class UsernameChange {
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  newUsername: string;
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: Credentials) {
    return this.auth.register(body.username, body.password);
  }

  @Post('login')
  login(@Body() body: Credentials) {
    return this.auth.login(body.username, body.password);
  }

  @Post('change-password')
  password(@UserId() user: number, @Body() body: PasswordChange) {
    return this.auth.changePassword(user, body.oldPassword, body.newPassword);
  }

  @Post('change-username')
  username(@UserId() user: number, @Body() body: UsernameChange) {
    return this.auth.changeUsername(user, body.newUsername);
  }
}
