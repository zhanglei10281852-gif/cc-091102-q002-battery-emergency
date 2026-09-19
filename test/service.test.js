import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { DecisionService } from '../src/service.js';
import { DomainError } from '../src/domain.js';

const FUTURE = '2099-01-01T00:00:00.000Z';

async function makeService(clock = () => Date.now()) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'batt-svc-'));
  const store = new EventStore(join(dir, 'events.log'));
  await store.load();
  const service = new DecisionService(store, { clock });
  return { service, store, dir };
}

async function seed(service, { lineCapacity = 3, grantExpires = FUTURE, reasonUntil = FUTURE } = {}) {
  await service.registerLine({ lineId: 'CELL-L3', capacity: lineCapacity });
  await service.registerReason({ reasonCode: 'sensor-runaway', validUntil: reasonUntil });
  await service.registerGrant({
    grantId: 'g-lead',
    subject: 'safety-lead',
    level: 'urgent-authorized',
    reasonCode: 'sensor-runaway',
    expiresAt: grantExpires,
  });
  await service.registerGrant({
    grantId: 'g-ops',
    subject: 'line-ops',
    level: 'ordinary',
    reasonCode: null,
    expiresAt: grantExpires,
  });
}

async function registerAlert(service, alertId, level = 'urgent-authorized', lineId = 'CELL-L3', demand = 1) {
  await service.registerAlert({ alertId, lineId, level, demand });
}

async function rejectCode(promise, code) {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, `期望抛出 ${code}，但命令成功返回`);
  assert.ok(err instanceof DomainError, `期望 DomainError，实际 ${err}`);
  assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}: ${err.message}`);
}

test('完整生命周期：登记→授权→锁定→确认→释放，容量扣减与回补各一次', async () => {
  const { service } = await makeService();
  await seed(service);
  await registerAlert(service, 'THERMAL-1');

  await service.dispatch('authorize', { commandId: 'c1', alertId: 'THERMAL-1', by: 'safety-lead', reasonCode: 'sensor-runaway' });
  const held = await service.dispatch('hold', { commandId: 'c2', alertId: 'THERMAL-1', by: 'safety-lead' });
  assert.equal(held.alertState, 'window-held');
  assert.equal(held.line.available, 2);
  assert.deepEqual(held.capacityChange, { type: 'window-held', delta: -1, capacityBefore: 3, capacityAfter: 2 });
  assert.equal(held.commitment.id, 'C-THERMAL-1');

  await service.dispatch('approve', { commandId: 'c3', alertId: 'THERMAL-1', by: 'safety-lead' });
  const released = await service.dispatch('release', { commandId: 'c4', alertId: 'THERMAL-1', by: 'safety-lead' });
  assert.equal(released.alertState, 'released');
  assert.equal(released.line.available, 3);
  assert.deepEqual(released.capacityChange, { type: 'window-released', delta: 1, capacityBefore: 2, capacityAfter: 3 });

  const view = service.getAlert('THERMAL-1');
  assert.equal(view.authorization.by, 'safety-lead');
  assert.equal(view.commitment.id, 'C-THERMAL-1');
  const commitment = service.getCommitment('C-THERMAL-1');
  assert.equal(commitment.alertId, 'THERMAL-1');
  assert.equal(commitment.by, 'safety-lead');
  assert.equal(commitment.state, 'released');
});

test('普通级别无需理由码；授权后未锁定即可撤销，容量不动', async () => {
  const { service } = await makeService();
  await seed(service);
  await registerAlert(service, 'THERMAL-2', 'ordinary');

  await service.dispatch('authorize', { commandId: 'c1', alertId: 'THERMAL-2', by: 'line-ops' });
  const cancelled = await service.dispatch('cancel', { commandId: 'c2', alertId: 'THERMAL-2', by: 'line-ops' });
  assert.equal(cancelled.alertState, 'cancelled');
  assert.equal(cancelled.line.available, 3);
  assert.equal(cancelled.capacityChange, null);
});

test('相同命令并发到达：共享第一次结果，只扣减一次', async () => {
  const { service, store } = await makeService();
  await seed(service);
  await registerAlert(service, 'THERMAL-3');
  await service.dispatch('authorize', { commandId: 'auth-3', alertId: 'THERMAL-3', by: 'safety-lead', reasonCode: 'sensor-runaway' });

  const body = { commandId: 'hold-3', alertId: 'THERMAL-3', by: 'safety-lead' };
  const [r1, r2, r3] = await Promise.all([
    service.dispatch('hold', body),
    service.dispatch('hold', body),
    service.dispatch('hold', body),
  ]);

  assert.equal(r1.replayed, false);
  assert.equal(r2.deduplicated, true);
  assert.equal(r3.deduplicated, true);
  assert.equal(r1.commitment.id, r2.commitment.id);
  assert.equal(service.getLine('CELL-L3').available, 2);
  const heldEvents = store.state.events.filter((e) => e.type === 'window-held');
  assert.equal(heldEvents.length, 1);
});

test('相同命令消息重投（顺序重试）：返回首次结果，不产生第二个事件', async () => {
  const { service, store } = await makeService();
  await seed(service);
  await registerAlert(service, 'THERMAL-4');
  await service.dispatch('authorize', { commandId: 'auth-4', alertId: 'THERMAL-4', by: 'safety-lead', reasonCode: 'sensor-runaway' });

  const body = { commandId: 'hold-4', alertId: 'THERMAL-4', by: 'safety-lead' };
  const first = await service.dispatch('hold', body);
  const retry = await service.dispatch('hold', body);
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(service.getLine('CELL-L3').available, 2);
  assert.equal(store.state.events.filter((e) => e.type === 'window-held').length, 1);
});

test('commandId 复用到不同预警：拒绝且不改变任何容量', async () => {
  const { service } = await makeService();
  await seed(service);
  await registerAlert(service, 'THERMAL-5A');
  await registerAlert(service, 'THERMAL-5B');
  await service.dispatch('authorize', { commandId: 'shared', alertId: 'THERMAL-5A', by: 'safety-lead', reasonCode: 'sensor-runaway' });

  await rejectCode(
    service.dispatch('authorize', { commandId: 'shared', alertId: 'THERMAL-5B', by: 'safety-lead', reasonCode: 'sensor-runaway' }),
    'COMMAND_CONFLICT',
  );
  assert.equal(service.getAlert('THERMAL-5B').state, 'submitted');
  assert.equal(service.getLine('CELL-L3').available, 3);
});

test('授权时凭据已过期：拒绝授权，不落事件、不动容量', async () => {
  let now = Date.parse('2090-01-01T00:00:00Z');
  const { service, store } = await makeService(() => now);
  await seed(service, { grantExpires: '2090-06-01T00:00:00.000Z' });
  await registerAlert(service, 'THERMAL-6');

  now = Date.parse('2091-01-01T00:00:00Z'); // 授权已过期
  await rejectCode(
    service.dispatch('authorize', { commandId: 'c1', alertId: 'THERMAL-6', by: 'safety-lead', reasonCode: 'sensor-runaway' }),
    'EXPIRED',
  );
  assert.equal(service.getAlert('THERMAL-6').state, 'submitted');
  assert.equal(service.getLine('CELL-L3').available, 3);
  assert.equal(store.state.events.filter((e) => e.type === 'alert-authorized').length, 0);
});

test('授权后、锁定前凭据过期：占用前再次校验，拒绝锁定且不扣减', async () => {
  let now = Date.parse('2090-01-01T00:00:00Z');
  const { service } = await makeService(() => now);
  await service.registerLine({ lineId: 'CELL-L3', capacity: 3 });
  await service.registerReason({ reasonCode: 'sensor-runaway', validUntil: FUTURE });
  await service.registerGrant({
    grantId: 'g', subject: 'safety-lead', level: 'urgent-authorized',
    reasonCode: 'sensor-runaway', expiresAt: '2090-06-01T00:00:00.000Z',
  });
  await registerAlert(service, 'THERMAL-7');
  await service.dispatch('authorize', { commandId: 'c1', alertId: 'THERMAL-7', by: 'safety-lead', reasonCode: 'sensor-runaway' });

  now = Date.parse('2091-01-01T00:00:00Z');
  await rejectCode(service.dispatch('hold', { commandId: 'c2', alertId: 'THERMAL-7', by: 'safety-lead' }), 'EXPIRED');
  assert.equal(service.getAlert('THERMAL-7').state, 'authorized');
  assert.equal(service.getLine('CELL-L3').available, 3);
});

test('理由依据过期与缺失理由码：紧急突破一律拒绝', async () => {
  const { service } = await makeService();
  await seed(service, { reasonUntil: '2000-01-01T00:00:00.000Z' });
  await registerAlert(service, 'THERMAL-8');

  await rejectCode(
    service.dispatch('authorize', { commandId: 'c1', alertId: 'THERMAL-8', by: 'safety-lead', reasonCode: 'sensor-runaway' }),
    'EXPIRED',
  );

  const { service: s2 } = await makeService();
  await seed(s2);
  await registerAlert(s2, 'THERMAL-8B');
  await rejectCode(
    s2.dispatch('authorize', { commandId: 'c2', alertId: 'THERMAL-8B', by: 'safety-lead' }),
    'REASON_REQUIRED',
  );
  assert.equal(s2.getLine('CELL-L3').available, 3);
});

test('越权：无相应级别授权、非原授权人操作，均拒绝且容量不变', async () => {
  const { service } = await makeService();
  await seed(service);
  await registerAlert(service, 'THERMAL-9');

  // line-ops 只有普通级别授权，不能批准紧急突破
  await rejectCode(
    service.dispatch('authorize', { commandId: 'c1', alertId: 'THERMAL-9', by: 'line-ops', reasonCode: 'sensor-runaway' }),
    'GRANT_MISSING',
  );

  await service.dispatch('authorize', { commandId: 'c2', alertId: 'THERMAL-9', by: 'safety-lead', reasonCode: 'sensor-runaway' });
  // 其他人不能代为锁定
  await rejectCode(service.dispatch('hold', { commandId: 'c3', alertId: 'THERMAL-9', by: 'line-ops' }), 'SUBJECT_MISMATCH');
  assert.equal(service.getLine('CELL-L3').available, 3);
});

test('关联错误：未知预警、未知产线、未授权即锁定，均不落事件', async () => {
  const { service } = await makeService();
  await seed(service);
  await rejectCode(service.dispatch('hold', { commandId: 'c1', alertId: 'NOPE', by: 'safety-lead' }), 'ALERT_NOT_FOUND');
  await rejectCode(service.registerAlert({ alertId: 'X', lineId: 'NO-LINE', level: 'ordinary' }), 'LINE_NOT_FOUND');

  await registerAlert(service, 'THERMAL-10');
  await rejectCode(service.dispatch('hold', { commandId: 'c2', alertId: 'THERMAL-10', by: 'safety-lead' }), 'INVALID_STATE');
  assert.equal(service.getLine('CELL-L3').available, 3);
});

test('配额不足时拒绝锁定；释放后再次锁定成功', async () => {
  const { service } = await makeService();
  await seed(service, { lineCapacity: 1 });
  await registerAlert(service, 'THERMAL-11A');
  await registerAlert(service, 'THERMAL-11B');
  for (const id of ['THERMAL-11A', 'THERMAL-11B']) {
    await service.dispatch('authorize', { commandId: `a-${id}`, alertId: id, by: 'safety-lead', reasonCode: 'sensor-runaway' });
  }

  await service.dispatch('hold', { commandId: 'h-11A', alertId: 'THERMAL-11A', by: 'safety-lead' });
  assert.equal(service.getLine('CELL-L3').available, 0);
  await rejectCode(service.dispatch('hold', { commandId: 'h-11B', alertId: 'THERMAL-11B', by: 'safety-lead' }), 'QUOTA_EXHAUSTED');

  await service.dispatch('approve', { commandId: 'p-11A', alertId: 'THERMAL-11A', by: 'safety-lead' });
  await service.dispatch('release', { commandId: 'r-11A', alertId: 'THERMAL-11A', by: 'safety-lead' });
  assert.equal(service.getLine('CELL-L3').available, 1);

  await service.dispatch('hold', { commandId: 'h-11B-retry', alertId: 'THERMAL-11B', by: 'safety-lead' });
  assert.equal(service.getLine('CELL-L3').available, 0);
});

test('已锁定后撤销在同一命令内原子回补；终态不可再变', async () => {
  const { service } = await makeService();
  await seed(service);
  await registerAlert(service, 'THERMAL-12');
  await service.dispatch('authorize', { commandId: 'c1', alertId: 'THERMAL-12', by: 'safety-lead', reasonCode: 'sensor-runaway' });
  await service.dispatch('hold', { commandId: 'c2', alertId: 'THERMAL-12', by: 'safety-lead' });
  assert.equal(service.getLine('CELL-L3').available, 2);

  const cancelled = await service.dispatch('cancel', { commandId: 'c3', alertId: 'THERMAL-12', by: 'safety-lead' });
  assert.equal(cancelled.alertState, 'cancelled');
  assert.equal(cancelled.line.available, 3);
  assert.deepEqual(cancelled.capacityChange, { type: 'alert-cancelled', delta: 1, capacityBefore: 2, capacityAfter: 3 });

  await rejectCode(service.dispatch('release', { commandId: 'c4', alertId: 'THERMAL-12', by: 'safety-lead' }), 'INVALID_STATE');
});

test('混合不同预警并发：各自只生效一次，总扣减等于预警数', async () => {
  const { service, store } = await makeService();
  await seed(service, { lineCapacity: 5 });
  const ids = ['THERMAL-13A', 'THERMAL-13B', 'THERMAL-13C'];
  for (const id of ids) {
    await registerAlert(service, id);
    await service.dispatch('authorize', { commandId: `auth-${id}`, alertId: id, by: 'safety-lead', reasonCode: 'sensor-runaway' });
  }
  await Promise.all(ids.map((id) =>
    Promise.all([
      service.dispatch('hold', { commandId: `hold-${id}`, alertId: id, by: 'safety-lead' }),
      service.dispatch('hold', { commandId: `hold-${id}`, alertId: id, by: 'safety-lead' }),
    ]),
  ));
  assert.equal(service.getLine('CELL-L3').available, 2);
  assert.equal(store.state.events.filter((e) => e.type === 'window-held').length, 3);
  for (const id of ids) {
    assert.equal(service.getAlert(id).commitment.id, `C-${id}`);
  }
});
