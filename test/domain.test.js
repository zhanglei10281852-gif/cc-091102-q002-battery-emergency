import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjection,
  applyEvent,
  replay,
  DomainError,
  validateProvision,
  validateAlertRegistration,
  validateSubmission,
  validateAuthorization,
  validateHold,
  validateCancellation,
  urgencyLevels,
  requestStates,
  approve,
  cancel,
} from '../src/domain.js';
import { DEFAULT_POLICY } from '../src/permissions.js';

const NOW = 1_000_000;

function seed() {
  const state = createProjection();
  applyEvent(state, { seq: 1, at: NOW, type: 'LineProvisioned', lineId: 'CELL-L3', dailyQuota: 2 });
  applyEvent(state, { seq: 2, at: NOW, type: 'AlertRegistered', alertId: 'A1', lineId: 'CELL-L3', severity: 'critical' });
  applyEvent(state, { seq: 3, at: NOW, type: 'CommandSubmitted', commandId: 'c1', alertId: 'A1', lineId: 'CELL-L3', urgency: 'urgent-authorized' });
  return state;
}

test('级别与状态集合保持 baseline 兼容', () => {
  assert.deepEqual(urgencyLevels, ['ordinary', 'urgent-authorized']);
  assert.ok(requestStates.includes('approved'));
});

test('紧急命令：授权、锁定、批准，配额随窗口锁定只扣一次', () => {
  const state = seed();
  const authorized = validateAuthorization(state, 'c1', { authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: NOW + 60_000 }, NOW, DEFAULT_POLICY);
  applyEvent(state, { seq: 4, at: NOW, type: 'Authorized', ...authorized });
  validateHold(state, 'c1', NOW);
  applyEvent(state, { seq: 5, at: NOW, type: 'WindowHeld', commandId: 'c1' });
  assert.equal(state.lines.get('CELL-L3').remaining, 1);
  assert.equal(state.commands.get('c1').state, 'window-held');
  assert.equal(state.commands.get('c1').capacityChange, -1);
  applyEvent(state, { seq: 6, at: NOW, type: 'Approved', commandId: 'c1', by: 'safety-lead' });
  assert.equal(state.commands.get('c1').state, 'approved');
  // 批准本身不再改变容量。
  assert.equal(state.lines.get('CELL-L3').remaining, 1);
});

test('未授权的紧急命令不能直接锁定窗口', () => {
  const state = seed();
  assert.throws(() => validateHold(state, 'c1', NOW), (e) => e.code === 'invalid-state');
});

test('过期授权在占用前被拒绝', () => {
  const state = seed();
  assert.throws(
    () => validateAuthorization(state, 'c1', { authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: NOW - 1 }, NOW, DEFAULT_POLICY),
    (e) => e.code === 'authorization-expired',
  );
});

test('授权后过期：锁定临界区再次拦截，不扣配额', () => {
  const state = seed();
  applyEvent(state, { seq: 4, at: NOW, type: 'Authorized', commandId: 'c1', authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: NOW + 1000 });
  assert.throws(() => validateHold(state, 'c1', NOW + 1001), (e) => e.code === 'authorization-expired');
  assert.equal(state.lines.get('CELL-L3').remaining, 2);
});

test('越权授权人、越权产线、非法理由均被拒绝', () => {
  const state = seed();
  assert.throws(
    () => validateAuthorization(state, 'c1', { authorizedBy: 'maintenance', reasonCode: 'sensor-runaway', expiresAt: NOW + 1000 }, NOW, DEFAULT_POLICY),
    (e) => e.code === 'unauthorized',
  );
  assert.throws(
    () => validateAuthorization(state, 'c1', { authorizedBy: 'ghost', reasonCode: 'sensor-runaway', expiresAt: NOW + 1000 }, NOW, DEFAULT_POLICY),
    (e) => e.code === 'principal-unknown',
  );
  assert.throws(
    () => validateAuthorization(state, 'c1', { authorizedBy: 'cell-foreman', reasonCode: 'bribe', expiresAt: NOW + 1000 }, NOW, DEFAULT_POLICY),
    (e) => e.code === 'reason-not-allowed',
  );
  // cell-foreman 只能管 CELL-L3：换一条产线即越权。
  applyEvent(state, { seq: 4, at: NOW, type: 'LineProvisioned', lineId: 'CELL-L9', dailyQuota: 1 });
  applyEvent(state, { seq: 5, at: NOW, type: 'AlertRegistered', alertId: 'A9', lineId: 'CELL-L9', severity: 'critical' });
  applyEvent(state, { seq: 6, at: NOW, type: 'CommandSubmitted', commandId: 'c9', alertId: 'A9', lineId: 'CELL-L9', urgency: 'urgent-authorized' });
  assert.throws(
    () => validateAuthorization(state, 'c9', { authorizedBy: 'cell-foreman', reasonCode: 'sensor-runaway', expiresAt: NOW + 1000 }, NOW, DEFAULT_POLICY),
    (e) => e.code === 'unauthorized',
  );
});

test('一个预警只能有一个活跃承诺：第二条关联命令被拒', () => {
  const state = seed();
  assert.throws(
    () => validateSubmission(state, { commandId: 'c2', alertId: 'A1', lineId: 'CELL-L3', urgency: 'ordinary' }),
    (e) => e.code === 'alert-committed',
  );
});

test('命令关联到与预警不同的产线被拒', () => {
  const state = createProjection();
  applyEvent(state, { seq: 1, at: NOW, type: 'LineProvisioned', lineId: 'CELL-L3', dailyQuota: 2 });
  applyEvent(state, { seq: 2, at: NOW, type: 'LineProvisioned', lineId: 'CELL-L4', dailyQuota: 2 });
  applyEvent(state, { seq: 3, at: NOW, type: 'AlertRegistered', alertId: 'A1', lineId: 'CELL-L3', severity: 'critical' });
  assert.throws(
    () => validateSubmission(state, { commandId: 'c1', alertId: 'A1', lineId: 'CELL-L4', urgency: 'ordinary' }),
    (e) => e.code === 'alert-line-mismatch',
  );
});

test('撤销已锁定窗口：同一条事件完成状态迁移与配额退还', () => {
  const state = seed();
  applyEvent(state, { seq: 4, at: NOW, type: 'Authorized', commandId: 'c1', authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: NOW + 60_000 });
  applyEvent(state, { seq: 5, at: NOW, type: 'WindowHeld', commandId: 'c1' });
  validateCancellation(state, 'c1');
  assert.throws(() => applyEvent(state, { seq: 6, at: NOW, type: 'Cancelled', commandId: 'c1', by: 'safety-lead', capacityRefund: false }), DomainError);
  // 上面的非法事件被拒绝后投影不变，seq 仍停在 5。
  assert.equal(state.seq, 5);
  applyEvent(state, { seq: 6, at: NOW, type: 'Cancelled', commandId: 'c1', by: 'safety-lead', capacityRefund: true });
  assert.equal(state.commands.get('c1').state, 'cancelled');
  assert.equal(state.lines.get('CELL-L3').remaining, 2);
  assert.equal(state.commitments.has('A1'), false);
});

test('释放窗口退回配额，命令可在重新授权后再次锁定', () => {
  const state = seed();
  applyEvent(state, { seq: 4, at: NOW, type: 'Authorized', commandId: 'c1', authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: NOW + 60_000 });
  applyEvent(state, { seq: 5, at: NOW, type: 'WindowHeld', commandId: 'c1' });
  applyEvent(state, { seq: 6, at: NOW, type: 'Released', commandId: 'c1' });
  assert.equal(state.lines.get('CELL-L3').remaining, 2);
  assert.equal(state.commands.get('c1').state, 'authorized');
  assert.equal(state.commands.get('c1').holdCount, 1);
  validateHold(state, 'c1', NOW);
  applyEvent(state, { seq: 7, at: NOW, type: 'WindowHeld', commandId: 'c1' });
  assert.equal(state.lines.get('CELL-L3').remaining, 1);
  assert.equal(state.commands.get('c1').holdCount, 2);
});

test('普通命令无需授权即可锁定，配额耗尽时拒绝', () => {
  const state = createProjection();
  applyEvent(state, { seq: 1, at: NOW, type: 'LineProvisioned', lineId: 'L1', dailyQuota: 1 });
  applyEvent(state, { seq: 2, at: NOW, type: 'AlertRegistered', alertId: 'A1', lineId: 'L1', severity: 'warning' });
  applyEvent(state, { seq: 3, at: NOW, type: 'AlertRegistered', alertId: 'A2', lineId: 'L1', severity: 'warning' });
  applyEvent(state, { seq: 4, at: NOW, type: 'CommandSubmitted', commandId: 'c1', alertId: 'A1', lineId: 'L1', urgency: 'ordinary' });
  applyEvent(state, { seq: 5, at: NOW, type: 'CommandSubmitted', commandId: 'c2', alertId: 'A2', lineId: 'L1', urgency: 'ordinary' });
  validateHold(state, 'c1', NOW);
  applyEvent(state, { seq: 6, at: NOW, type: 'WindowHeld', commandId: 'c1' });
  assert.throws(() => validateHold(state, 'c2', NOW), (e) => e.code === 'quota-exhausted');
  // 已锁定命令的重复锁定按重放处理，不报错、不二次扣减。
  assert.equal(validateHold(state, 'c1', NOW).state, 'window-held');
});

test('事件序号断裂被判定为日志损坏', () => {
  const state = createProjection();
  assert.throws(() => applyEvent(state, { seq: 5, at: NOW, type: 'LineProvisioned', lineId: 'L1', dailyQuota: 1 }), (e) => e.code === 'corrupt-log');
});

test('replay 能从事件流重建完全一致的配额', () => {
  const events = [
    { seq: 1, at: NOW, type: 'LineProvisioned', lineId: 'L1', dailyQuota: 3 },
    { seq: 2, at: NOW, type: 'AlertRegistered', alertId: 'A1', lineId: 'L1', severity: 'critical' },
    { seq: 3, at: NOW, type: 'AlertRegistered', alertId: 'A2', lineId: 'L1', severity: 'warning' },
    { seq: 4, at: NOW, type: 'CommandSubmitted', commandId: 'c1', alertId: 'A1', lineId: 'L1', urgency: 'ordinary' },
    { seq: 5, at: NOW, type: 'WindowHeld', commandId: 'c1' },
    { seq: 6, at: NOW, type: 'CommandSubmitted', commandId: 'c2', alertId: 'A2', lineId: 'L1', urgency: 'ordinary' },
    { seq: 7, at: NOW, type: 'WindowHeld', commandId: 'c2' },
    { seq: 8, at: NOW, type: 'Released', commandId: 'c1' },
  ];
  const state = replay(events);
  assert.equal(state.lines.get('L1').remaining, 2);
  assert.equal(state.lines.get('L1').holds, 2);
  assert.equal(state.lines.get('L1').refunds, 1);
});

test('输入校验：非法配额与级别', () => {
  assert.throws(() => validateProvision({ lineId: 'L1', dailyQuota: -1 }), (e) => e.code === 'validation');
  assert.throws(() => validateProvision({ lineId: 'L1', dailyQuota: 1.5 }), (e) => e.code === 'validation');
  const state = createProjection();
  assert.throws(() => validateAlertRegistration(state, { alertId: 'A1', lineId: 'L1' }), (e) => e.code === 'not-found');
});

test('baseline approve/cancel 旧形状仍然可用', () => {
  const legacy = { records: [], remaining: 1, audit: [] };
  const rec = approve(legacy, { alertId: 'A1', commandId: 'x', at: NOW });
  assert.equal(rec.state, 'approved');
  assert.equal(legacy.remaining, 0);
  cancel(legacy, rec);
  assert.equal(legacy.remaining, 1);
});
