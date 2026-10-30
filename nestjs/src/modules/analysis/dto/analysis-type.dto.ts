import { IsIn } from 'class-validator';

export class AnalysisTypeDto {
  @IsIn(['SUMMARY', 'OUTLINE', 'FLASHCARD'])
  type: string;
}
