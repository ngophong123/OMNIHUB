import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowed } from '../../apps/api/src/domain';
import { classifyError, Errors } from '../../apps/api/src/errors';

const requireFromApi = createRequire(join(process.cwd(), 'apps/api/package.json'));
const { HttpException } = requireFromApi('@nestjs/common') as {
  HttpException: new (response: string | Record<string, unknown>, status: number) => Error;
};

describe('Errors classification and sanitization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves safe 4xx domain error codes and hides framework path messages', () => {
    expect(classifyError(new HttpException('ORDER_EMPTY', 400))).toEqual({
      status: 400,
      code: 'ORDER_EMPTY',
      errorType: 'HttpException',
      shouldLog: false,
    });

    expect(classifyError(new HttpException('Cannot GET /public/qr/secret-token?foo=1', 404))).toEqual({
      status: 404,
      code: 'ROUTE_NOT_FOUND',
      errorType: 'HttpException',
      shouldLog: false,
    });

    expect(classifyError(new HttpException('Column users.password_hash leaked in detail', 400))).toEqual({
      status: 400,
      code: 'BAD_REQUEST',
      errorType: 'HttpException',
      shouldLog: false,
    });
  });

  it('redacts 5xx HttpException internals except explicit safe 503 operational codes', () => {
    expect(classifyError(new HttpException('Internal SQL connection string postgresql://u:p@host', 500))).toEqual({
      status: 500,
      code: 'INTERNAL_SERVER_ERROR',
      errorType: 'HttpException',
      shouldLog: true,
    });

    expect(classifyError(new HttpException('REDIS_REQUIRED_FOR_PROTECTED_RATE_LIMITS', 503))).toEqual({
      status: 503,
      code: 'REDIS_REQUIRED_FOR_PROTECTED_RATE_LIMITS',
      errorType: 'HttpException',
      shouldLog: true,
    });

    expect(classifyError(new HttpException('redis://:secret@redis:6379 ECONNREFUSED', 503))).toEqual({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      errorType: 'HttpException',
      shouldLog: true,
    });
  });

  it('maps Prisma known, initialization, validation, and panic errors accurately without misclassifying P2025 as 503', () => {
    const p2025 = new Prisma.PrismaClientKnownRequestError('Record not found', { code: 'P2025', clientVersion: '6.19.0' });
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique violation', { code: 'P2002', clientVersion: '6.19.0' });
    const p2034 = new Prisma.PrismaClientKnownRequestError('Serialization failure', { code: 'P2034', clientVersion: '6.19.0' });
    const p2003 = new Prisma.PrismaClientKnownRequestError('FK violation', { code: 'P2003', clientVersion: '6.19.0' });
    const p2023 = new Prisma.PrismaClientKnownRequestError('Invalid UUID', { code: 'P2023', clientVersion: '6.19.0' });
    const p1001 = new Prisma.PrismaClientKnownRequestError('DB unreachable', { code: 'P1001', clientVersion: '6.19.0' });
    const p2024 = new Prisma.PrismaClientKnownRequestError('Pool timeout', { code: 'P2024', clientVersion: '6.19.0' });
    const p9999 = new Prisma.PrismaClientKnownRequestError('Unhandled prisma error', { code: 'P9999', clientVersion: '6.19.0' });
    const initErr = new Prisma.PrismaClientInitializationError('Cannot connect', '6.19.0', 'P1001');
    const valErr = new Prisma.PrismaClientValidationError('Invalid field', { clientVersion: '6.19.0' });
    const panicErr = new Prisma.PrismaClientRustPanicError('Engine panic', '6.19.0');

    expect(classifyError(p2025)).toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND', prismaCode: 'P2025', shouldLog: false });
    expect(classifyError(p2002)).toMatchObject({ status: 409, code: 'CONFLICT', prismaCode: 'P2002', shouldLog: false });
    expect(classifyError(p2034)).toMatchObject({ status: 409, code: 'CONCURRENCY_CONFLICT', prismaCode: 'P2034', shouldLog: false });
    expect(classifyError(p2003)).toMatchObject({ status: 400, code: 'INVALID_REFERENCE_OR_INPUT', prismaCode: 'P2003', shouldLog: false });
    expect(classifyError(p2023)).toMatchObject({ status: 400, code: 'INVALID_REFERENCE_OR_INPUT', prismaCode: 'P2023', shouldLog: false });
    expect(classifyError(p1001)).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE', prismaCode: 'P1001', shouldLog: true });
    expect(classifyError(p2024)).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE', prismaCode: 'P2024', shouldLog: true });
    expect(classifyError(p9999)).toMatchObject({ status: 500, code: 'INTERNAL_SERVER_ERROR', prismaCode: 'P9999', shouldLog: true });
    expect(classifyError(initErr)).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE', prismaCode: 'P1001', shouldLog: true });
    expect(classifyError(valErr)).toMatchObject({ status: 500, code: 'INTERNAL_SERVER_ERROR', shouldLog: true });
    expect(classifyError(panicErr)).toMatchObject({ status: 500, code: 'INTERNAL_SERVER_ERROR', shouldLog: true });
  });

  it('classifies body-parser syntax/payload errors and unexpected runtime Errors safely', () => {
    const jsonSyntax = Object.assign(new SyntaxError('Unexpected token } in JSON at position 12'), { status: 400 });
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' });
    const runtimeErr = new Error('SELECT * FROM "User" WHERE token = super_secret_value');

    expect(classifyError(jsonSyntax)).toEqual({ status: 400, code: 'INVALID_JSON_BODY', errorType: 'SyntaxError', shouldLog: false });
    expect(classifyError(tooLarge)).toEqual({ status: 413, code: 'PAYLOAD_TOO_LARGE', errorType: 'Error', shouldLog: false });
    expect(classifyError(runtimeErr)).toEqual({ status: 500, code: 'INTERNAL_SERVER_ERROR', errorType: 'Error', shouldLog: true });
  });

  it('logs redacted structured JSON on 5xx without leaking secret path tokens or messages', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const jsonMock = vi.fn();
    const statusMock = vi.fn(() => ({ json: jsonMock }));
    const rawSecretToken = 'f'.repeat(64);
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          originalUrl: `/public/qr/${rawSecretToken}/session?debugSecret=leak_me`,
        }),
        getResponse: () => ({
          getHeader: (name: string) => (name === 'x-correlation-id' ? 'corr-999' : undefined),
          status: statusMock,
        }),
      }),
    };

    const filter = new Errors();
    filter.catch(new Error('postgres://admin:supersecret@db:5432/omnihub'), host as never);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ code: 'INTERNAL_SERVER_ERROR', correlationId: 'corr-999' });
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const loggedText = String(errorSpy.mock.calls[0]?.[0] ?? '');
    const parsed = JSON.parse(loggedText) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: 'error',
      code: 'INTERNAL_SERVER_ERROR',
      statusCode: 500,
      errorType: 'Error',
      method: 'POST',
      path: '/public/qr/:credential/session',
      correlationId: 'corr-999',
    });
    expect(loggedText).not.toContain(rawSecretToken);
    expect(loggedText).not.toContain('supersecret');
    expect(loggedText).not.toContain('debugSecret');

    errorSpy.mockClear();
    filter.catch(new HttpException('Cannot GET /missing', 404), host as never);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenLastCalledWith({ code: 'ROUTE_NOT_FOUND', correlationId: 'corr-999' });
  });

  it('enforces admin RBAC permission in domain policy', () => {
    expect(allowed('OWNER', 'admin')).toBe(true);
    expect(allowed('MANAGER', 'admin')).toBe(true);
    expect(allowed('CASHIER', 'admin')).toBe(false);
    expect(allowed('KITCHEN', 'admin')).toBe(false);
    expect(allowed('INVENTORY', 'admin')).toBe(false);
  });
});
