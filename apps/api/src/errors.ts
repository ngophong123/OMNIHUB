import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { accessLogPath } from './deployment-security';
import { apiLogger } from './observability/logger';
import { getLogContext } from './observability/request-context';

export type ClassifiedError = {
  status: number;
  code: string;
  errorType: string;
  prismaCode?: string;
  shouldLog: boolean;
};

const SAFE_ERROR_CODE_RE = /^[A-Z0-9_]{2,80}$/;

const STATUS_CODE_MAP: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
};

const PRISMA_INPUT_CODES = new Set([
  'P2000',
  'P2003',
  'P2005',
  'P2006',
  'P2007',
  'P2011',
  'P2012',
  'P2014',
  'P2023',
]);

function readHttpLikeError(error: unknown): { status: number; type?: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = typeof candidate.status === 'number'
    ? candidate.status
    : typeof candidate.statusCode === 'number'
      ? candidate.statusCode
      : undefined;
  if (!status || !Number.isInteger(status) || status < 400 || status > 599) return null;
  return { status, type: typeof candidate.type === 'string' ? candidate.type : undefined };
}

/**
 * Classifies framework, database, parser, and unexpected runtime failures into
 * sanitized HTTP status/code pairs without exposing internal messages or stacks.
 */
export function classifyError(error: unknown): ClassifiedError {
  const errorType = error instanceof Error ? error.name : typeof error;

  if (error instanceof HttpException) {
    const status = error.getStatus();
    const message = error.message;
    if (status >= 500) {
      const code = status === 503 && SAFE_ERROR_CODE_RE.test(message)
        ? message
        : status === 503
          ? 'SERVICE_UNAVAILABLE'
          : 'INTERNAL_SERVER_ERROR';
      return { status, code, errorType, shouldLog: true };
    }
    const code = SAFE_ERROR_CODE_RE.test(message)
      ? message
      : status === 404 && message.startsWith('Cannot ')
        ? 'ROUTE_NOT_FOUND'
        : STATUS_CODE_MAP[status] ?? 'REQUEST_REJECTED';
    return { status, code, errorType, shouldLog: false };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') {
      return { status: 404, code: 'RESOURCE_NOT_FOUND', errorType, prismaCode: error.code, shouldLog: false };
    }
    if (error.code === 'P2002') {
      return { status: 409, code: 'CONFLICT', errorType, prismaCode: error.code, shouldLog: false };
    }
    if (error.code === 'P2034') {
      return { status: 409, code: 'CONCURRENCY_CONFLICT', errorType, prismaCode: error.code, shouldLog: false };
    }
    if (PRISMA_INPUT_CODES.has(error.code)) {
      return { status: 400, code: 'INVALID_REFERENCE_OR_INPUT', errorType, prismaCode: error.code, shouldLog: false };
    }
    if (error.code.startsWith('P10') || error.code === 'P2024') {
      return { status: 503, code: 'SERVICE_UNAVAILABLE', errorType, prismaCode: error.code, shouldLog: true };
    }
    return { status: 500, code: 'INTERNAL_SERVER_ERROR', errorType, prismaCode: error.code, shouldLog: true };
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return { status: 503, code: 'SERVICE_UNAVAILABLE', errorType, prismaCode: error.errorCode, shouldLog: true };
  }

  if (error instanceof Prisma.PrismaClientRustPanicError || error instanceof Prisma.PrismaClientValidationError) {
    return { status: 500, code: 'INTERNAL_SERVER_ERROR', errorType, shouldLog: true };
  }

  const httpLike = readHttpLikeError(error);
  if (httpLike && httpLike.status < 500) {
    const code = error instanceof SyntaxError && httpLike.status === 400
      ? 'INVALID_JSON_BODY'
      : httpLike.type === 'entity.too.large'
        ? 'PAYLOAD_TOO_LARGE'
        : STATUS_CODE_MAP[httpLike.status] ?? 'REQUEST_REJECTED';
    return { status: httpLike.status, code, errorType, shouldLog: false };
  }

  return { status: 500, code: 'INTERNAL_SERVER_ERROR', errorType, shouldLog: true };
}

/** Global HTTP exception filter emitting redacted structured JSON error logs and safe error envelopes. */
@Catch()
export class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request | undefined>();
    const response = http.getResponse<Response>();
    const correlationId = response.getHeader('x-correlation-id') ?? getLogContext()?.correlationId;
    const classified = classifyError(error);

    if (classified.shouldLog) {
      const pathSource = request?.originalUrl ?? request?.url;
      apiLogger.ops('error', classified.code, {
        component: 'http-exception-filter',
        statusCode: classified.status,
        errorType: classified.errorType,
        ...(classified.prismaCode ? { prismaCode: classified.prismaCode } : {}),
        ...(request?.method ? { method: request.method } : {}),
        ...(pathSource ? { path: accessLogPath(pathSource) } : {}),
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
    }

    response.status(classified.status).json({ code: classified.code, correlationId });
  }
}
