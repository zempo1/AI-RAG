import { IsString, IsNotEmpty, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  oldPassword: string;

  @IsString()
  @MinLength(6)
  @MaxLength(72)
  newPassword: string;
}
