import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class CredentialsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  username: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  password: string;
}
