import { CredentialsDto } from './dto/credentials.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangeUsernameDto } from './dto/change-username.dto';
import { Body, Controller, Post } from '@nestjs/common';

import { AuthService } from './auth.service';
import { UserId } from './auth.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: CredentialsDto) {
    return this.auth.register(body.username, body.password);
  }

  @Post('login')
  login(@Body() body: CredentialsDto) {
    return this.auth.login(body.username, body.password);
  }

  @Post('change-password')
  password(@UserId() user: number, @Body() body: ChangePasswordDto) {
    return this.auth.changePassword(user, body.oldPassword, body.newPassword);
  }

  @Post('change-username')
  username(@UserId() user: number, @Body() body: ChangeUsernameDto) {
    return this.auth.changeUsername(user, body.newUsername);
  }
}
