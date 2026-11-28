import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Role } from '@omnihub/contracts';

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEY_LENGTH = 64;

function scryptAsync(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS).toString('hex')}`;
}
export function verifyPassword(password: string, encoded: string): boolean {
  const [salt, hash] = encoded.split(':');
  if (!salt || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS));
}
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt);
  return `${salt}:${derived.toString('hex')}`;
}
export async function verifyPasswordAsync(password: string, encoded: string): Promise<boolean> {
  const [salt, hash] = encoded.split(':');
  if (!salt || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const derived = await scryptAsync(password, salt);
  return timingSafeEqual(Buffer.from(hash, 'hex'), derived);
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export type Permission = 'read' | 'pos' | 'kitchen' | 'handoff' | 'cancelPending' | 'cancelStarted' | 'cash' | 'cashShift' | 'cashApprove' | 'inventory' | 'report' | 'catalog' | 'admin';
const policy: Record<Permission, readonly Role[]> = {
  catalog: ['OWNER', 'MANAGER'],
  admin: ['OWNER', 'MANAGER'],
  read: ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY'],
  pos: ['OWNER', 'MANAGER', 'CASHIER'], kitchen: ['OWNER', 'MANAGER', 'KITCHEN'],
  handoff: ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN'], cancelPending: ['OWNER', 'MANAGER', 'CASHIER'],
  cancelStarted: ['OWNER', 'MANAGER'], cash: ['OWNER', 'MANAGER', 'CASHIER'],
  cashShift: ['OWNER', 'MANAGER', 'CASHIER'], cashApprove: ['OWNER', 'MANAGER'],
  inventory: ['OWNER', 'MANAGER', 'INVENTORY'], report: ['OWNER', 'MANAGER'],
};
export const allowed = (role: Role, permission: Permission): boolean => policy[permission].includes(role);
export function totalDue(items: readonly { unitPrice: number; status: string }[]): number {
  const total = items.filter(i => i.status !== 'CANCELLED').reduce((sum, i) => {
    if (!Number.isSafeInteger(i.unitPrice) || i.unitPrice < 0) throw new Error('INVALID_MONEY');
    return sum + i.unitPrice;
  }, 0);
  if (!Number.isSafeInteger(total) || total > 1_000_000_000) throw new Error('TOTAL_LIMIT');
  return total;
}
  export function allocateVnd(total: number, recipients: readonly { id: string; weight: number }[]): Record<string, number> {
    if (!Number.isSafeInteger(total) || total < 0 || total > 1_000_000_000 || recipients.length === 0 || new Set(recipients.map(r => r.id)).size !== recipients.length || recipients.some(r => !Number.isSafeInteger(r.weight) || r.weight < 0)) throw new Error('INVALID_ALLOCATION');
    const weightTotal = recipients.reduce((sum, recipient) => sum + BigInt(recipient.weight), 0n);
    if (weightTotal <= 0n) throw new Error('INVALID_ALLOCATION');
    const exact = recipients.map(recipient => { const numerator = BigInt(total) * BigInt(recipient.weight); return { id: recipient.id, base: Number(numerator / weightTotal), remainder: numerator % weightTotal }; });
    const remainder = total - exact.reduce((sum, row) => sum + row.base, 0);
    exact.sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1);
    for (let i = 0; i < remainder; i++) exact[i]!.base++;
    return Object.fromEntries(exact.map(row => [row.id, row.base]));
  }
export function cashExpected(opening: number, payments: number, movements: readonly { kind: string; amount: number }[]): number {
  const amounts = [opening, payments, ...movements.map(m => m.amount)];
  if (amounts.some(n => !Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000)) throw new Error('INVALID_CASH_AMOUNT');
  const movementTotal = movements.reduce((sum, movement) => {
    if (!['CASH_IN', 'CASH_OUT', 'REFUND', 'CORRECTION_IN', 'CORRECTION_OUT'].includes(movement.kind)) throw new Error('INVALID_CASH_MOVEMENT');
    return sum + (['CASH_IN', 'CORRECTION_IN'].includes(movement.kind) ? movement.amount : -movement.amount);
  }, 0);
  const total = opening + payments + movementTotal;
  if (!Number.isSafeInteger(total) || total < 0 || total > 1_000_000_000) throw new Error('INVALID_EXPECTED_CASH');
  return total;
}
export function businessDate(now: Date, cutoffMinutes: number, timezone: string): string {
  if (timezone !== 'Asia/Ho_Chi_Minh' || !Number.isInteger(cutoffMinutes) || cutoffMinutes < 0 || cutoffMinutes >= 1440) throw new Error('UNSUPPORTED_BUSINESS_CLOCK');
  return new Date(now.getTime() + (420 - cutoffMinutes) * 60_000).toISOString().slice(0, 10);
}
export function transition(status: string, action: string): string | null {
  if (action === 'CANCEL') return status !== 'CANCELLED' ? 'CANCELLED' : null;
  const transitions: Record<string, Record<string, string>> = { START: { PENDING: 'PREPARING' }, READY: { PREPARING: 'READY' }, HANDOFF: { READY: 'HANDED_OFF' } };
  return transitions[action]?.[status] ?? null;
}
export function convertUnit(value: string, from: string, to: string): string {
  if (!/^\d+(\.\d{1,3})?$/.test(value)) throw new Error('INVALID_QUANTITY');
  const factors: Record<string, [string, bigint]> = { g: ['mass', 1n], kg: ['mass', 1000n], ml: ['volume', 1n], l: ['volume', 1000n], piece: ['piece', 1n] };
  const a = factors[from]; const b = factors[to];
  if (!a || !b || a[0] !== b[0]) throw new Error('INCOMPATIBLE_UNITS');
  const [whole = '0', fraction = ''] = value.split('.');
  const milli = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  const numerator = milli * a[1];
  if (numerator % b[1] !== 0n) throw new Error('PRECISION_LOSS');
  const converted = numerator / b[1];
  return `${converted / 1000n}.${(converted % 1000n).toString().padStart(3, '0')}`;
}
