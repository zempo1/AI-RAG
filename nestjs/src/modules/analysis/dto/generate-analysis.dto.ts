import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AnalysisTypeDto } from './analysis-type.dto';

export class GenerateAnalysisDto extends AnalysisTypeDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  documentId: number;
}
