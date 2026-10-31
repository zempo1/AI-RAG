import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min, Max, MaxLength, IsIn } from 'class-validator';

export class NameDto {
  @IsString() @MaxLength(120) name: string;
}
export class KnowledgeBaseDto extends NameDto {
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
export class DocumentQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsIn(['pending', 'queued', 'ready', 'failed']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) categoryId?: number;
}
export class DocumentUpdateDto {
  @IsOptional() @IsString() @MaxLength(255) filename?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) categoryId?: number | null;
}
