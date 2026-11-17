import { IsInt, IsString, Length, Min } from "class-validator";
import { Type } from "class-transformer";

export class GenerateMindMapDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  documentId: number;

  @IsString()
  @Length(1, 100)
  requestId: string;
}
