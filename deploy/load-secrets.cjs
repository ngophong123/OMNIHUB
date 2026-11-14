/* eslint-disable @typescript-eslint/no-require-imports */
/* global process, require */
const { readFileSync } = require('node:fs');
const read = name => readFileSync(`/run/secrets/${name}`, 'utf8').trim();
const database = process.env.DB_NAME || 'omnihub_staging';
if (!/^omnihub_staging(?:_restore_\d+_[a-f0-9]{8})?$/.test(database)) throw new Error('INVALID_STAGING_DATABASE_NAME');
process.env.DATABASE_URL = `postgresql://${process.env.DB_ROLE || 'omnihub_app'}:${encodeURIComponent(read(process.env.DB_PASSWORD_SECRET || 'db_app_password'))}@postgres:5432/${database}?schema=public&connection_limit=8&connect_timeout=3&pool_timeout=5`;
process.env.REDIS_URL = `redis://app:${encodeURIComponent(read('redis_password'))}@redis:6379`;
process.env.QR_TOKEN_SECRET = read('qr_secret');
if (process.env.SEED_DEMO === 'true') process.env.DEMO_PASSWORD = read('demo_password');
