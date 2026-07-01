import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { WorkflowValidationError } from '@monai-devops/core-engine';

interface ErrorResponseBody {
  statusCode: number;
  message: string;
  error: string;
  code?: string;
  details?: unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const body = this.toErrorBody(exception);
    if (body.statusCode >= 500) {
      this.logger.error(body.message, exception instanceof Error ? exception.stack : undefined);
    }

    response.status(body.statusCode).json(body);
  }

  private toErrorBody(exception: unknown): ErrorResponseBody {
    if (exception instanceof WorkflowValidationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: exception.message,
        error: 'WorkflowValidationError',
        code: 'WORKFLOW_VALIDATION_ERROR',
        details: { name: exception.name },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        return {
          statusCode: status,
          message: exceptionResponse,
          error: exception.name,
        };
      }

      const payload = exceptionResponse as Record<string, unknown>;
      return {
        statusCode: status,
        message: String(payload.message ?? exception.message),
        error: String(payload.error ?? exception.name),
        code: typeof payload.code === 'string' ? payload.code : undefined,
        details: payload.details,
      };
    }

    if (exception instanceof Error) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: exception.message,
        error: exception.name,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'InternalServerError',
    };
  }
}
