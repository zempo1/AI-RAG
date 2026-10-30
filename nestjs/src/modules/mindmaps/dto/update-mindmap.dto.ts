import { IsString } from 'class-validator';

export class UpdateMindMapDto {
  @IsString({ message: 'data 字段必须是 JSON 字符串' })
  data: string;
}
