import '../../apps/api/node_modules/reflect-metadata';
import { describe, expect, it } from 'vitest';
import { NestFactory } from '../../apps/api/node_modules/@nestjs/core';

type ExpressRouterLayer = {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
  };
};

describe('API feature module composition and route parity (M2-T12)', () => {
  it('initializes AppModule cleanly via NestJS DI and registers all 83 domain HTTP routes', async () => {
    const httpModuleId = ['..', '..', 'apps', 'api', 'src', 'http'].join('/');
    const { AppModule } = (await import(httpModuleId)) as { AppModule: new () => unknown };
    const app = await NestFactory.create(AppModule, { logger: false });
    try {
      await app.init();
      const expressInstance = app.getHttpAdapter().getInstance() as {
        router?: { stack?: ExpressRouterLayer[] };
        _router?: { stack?: ExpressRouterLayer[] };
      };
      const stack = expressInstance.router?.stack ?? expressInstance._router?.stack ?? [];
      const registered = new Set<string>();
      for (const layer of stack) {
        if (!layer.route?.path || !layer.route.methods) continue;
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) registered.add(`${method.toUpperCase()} ${layer.route.path}`);
        }
      }

      expect(registered.size).toBe(83);
      for (const criticalRoute of [
        'GET /health',
        'GET /ready',
        'POST /auth/login',
        'GET /auth/me',
        'POST /auth/logout',
        'GET /orders',
        'POST /orders',
        'POST /orders/:id/cancel',
        'POST /items/:id/commands',
        'GET /orders/:id/payments',
        'POST /orders/:id/payments',
        'POST /orders/:id/splits',
        'POST /payments/:id/verify',
        'POST /payments/:id/fail',
        'POST /payments/:id/refunds',
        'POST /refunds/:id/decision',
        'GET /reports/daily',
        'GET /cash/shifts',
        'POST /cash/shifts',
        'POST /cash/shifts/:id/close',
        'POST /cash/shifts/:id/approve',
        'POST /cash/movements',
        'POST /kitchen/devices/register',
        'POST /kitchen/sync',
        'GET /public/qr/:token/menu',
        'POST /public/table-sessions/orders',
        'GET /admin/outbox/dead-letters',
        'POST /admin/outbox/dead-letters/replay',
        'GET /admin/pilot-readiness',
        'POST /public/invitations/:token/accept',
      ]) {
        expect(registered.has(criticalRoute)).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});
