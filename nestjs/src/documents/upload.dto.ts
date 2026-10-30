import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, Max, Min } from 'class-validator';

export class UploadCheckDto {
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
