import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangeUsernameDto {
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  newUsername: string;
}
