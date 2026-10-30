import { PipeTransform, Injectable } from '@nestjs/common';
import { ApiError } from '../api-error';

@Injectable()
export class IdPipe implements PipeTransform {
  transform(value: string): number {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, '参数错误: id');
    return id;
  }
}
