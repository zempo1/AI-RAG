import { HttpException } from '@nestjs/common';

export class ApiError extends HttpException {
  constructor(code: number, message: string) {
    super(message, code);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
