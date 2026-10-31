import { Type } from 'class-transformer';
import { IsInt, IsString, IsOptional, Matches, Max, Min, MaxLength } from 'class-validator';

export class UploadOptionsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) knowledgeBaseId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) documentId?: number;
  @IsOptional() @IsString() @Matches(/^[a-zA-Z0-9-]{1,80}$/) uploadId?: string;
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
}

export class UploadCheckDto extends UploadOptionsDto {
  @IsString()
  @Matches(/^[a-fA-F0-9]{32}$/)
  md5: string;

  @IsString()
  filename: string;
}

export class MergeDto extends UploadCheckDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  totalChunks: number;
}

export class ChunkDto extends MergeDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  chunkIndex: number;
}
