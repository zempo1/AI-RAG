import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class GenerateMindMapDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  documentId?: number | null;
}
