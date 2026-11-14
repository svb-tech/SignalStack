// Dependency-free auth primitives: HS256 JWT + scrypt password hashing (Node built-ins only).
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const b64 = (x) => Buffer.from(x).toString('base64url');
const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function signToken(payload, secret, expiresInSec) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec }))}`;
  return `${body}.${mac(body, secret)}`;
}

/** Returns the payload, or null for anything invalid: bad shape, bad signature, wrong alg, expired. */
export function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const want = Buffer.from(mac(`${h}.${p}`, secret)), got = Buffer.from(s);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const payload = JSON.parse(Buffer.from(p, 'base64url'));
    if (header.alg !== 'HS256' || !(payload.exp > Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split(':');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'hex');
  const got = await scrypt(password, Buffer.from(salt, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}
