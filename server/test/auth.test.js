import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, hashPassword, verifyPassword } from '../src/jwt.js';
import { istDate, istTime, istDayStart, istDayEnd, weekKey } from '../src/util.js';

const S = 'a-test-secret-that-is-long-enough-123456';

test('JWT round-trip, tamper, wrong secret, expiry, alg confusion', () => {
  const t = signToken({ sub: 'u1' }, S, 60);
  assert.equal(verifyToken(t, S).sub, 'u1');
  assert.equal(verifyToken(t, 'other-secret'), null);
  const [h, p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: 9e9 })).toString('base64url');
  assert.equal(verifyToken(`${h}.${forged}.${s}`, S), null);
  assert.equal(verifyToken(signToken({ sub: 'u1' }, S, -1), S), null);
  const none = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(verifyToken(`${none({ alg: 'none' })}.${p}.`, S), null);
  assert.equal(verifyToken('garbage', S), null);
  assert.equal(verifyToken(undefined, S), null);
});

test('passwords: hashed, salted, verified', async () => {
  const a = await hashPassword('correct horse'), b = await hashPassword('correct horse');
  assert.notEqual(a, b);
  assert.ok(await verifyPassword('correct horse', a));
  assert.ok(!(await verifyPassword('wrong', a)));
  assert.ok(!(await verifyPassword('x', 'not-a-hash')));
});

test('IST helpers and week key use Indian time', () => {
  assert.equal(istDate('2026-11-13T20:00:00Z'), '2026-11-14'); // 01:30 IST next day
  assert.equal(istTime('2026-11-14T00:00:00Z'), '05:30:00');
  assert.equal(istDate('nonsense'), 'n/a');
  assert.equal(istDayStart('2026-11-14').toISOString(), '2026-11-13T18:30:00.000Z');
  assert.equal(istDayEnd('2026-11-14').toISOString(), '2026-11-14T18:29:59.999Z');
  assert.equal(weekKey(new Date('2026-11-15T17:00:00Z')), '2026-W46'); // Sun 22:30 IST
  assert.equal(weekKey(new Date('2026-11-15T19:00:00Z')), '2026-W47'); // Mon 00:30 IST
});
