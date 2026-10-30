import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from './common/api-error';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';

export function configureApp(app: INestApplication): void {
  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      req.headers['content-type']?.startsWith('multipart/') &&
      Number(req.headers['content-length']) > 10 * 1024 * 1024
    ) {
      req.once('end', () => res.status(413).json({ code: 413, message: '文件过大' }));
      req.resume();
      return;
    }
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      exceptionFactory: (errors) =>
        new ApiError(
          400,
          '参数错误: ' +
            errors.map((e) => Object.values(e.constraints || {}).join(', ')).join('; '),
        ),
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ApiResponseInterceptor());
  // Spring controllers return HTTP 200 for successful POST and DELETE requests.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const original = res.status.bind(res);
    res.status = ((code: number) => original(code === 201 ? 200 : code)) as Response['status'];
    next();
  });
}
