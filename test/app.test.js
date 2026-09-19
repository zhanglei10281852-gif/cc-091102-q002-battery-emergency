import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHarness, seedLineAndAlert, authorizedCommand } from './helpers.js';
import { DomainError } from '../src/domain.js';

async function expectError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DomainError, `期望 DomainError，实际 ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('完整决策链路：登记→提交→授权→锁定→批准，并按预警编号核对', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h, { dailyQuota: 3 });
    await h.app.submitCommand({ commandId: 'cmd-88', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'urgent-authorized' });
    await h.app.authorizeCommand('cmd-88', { authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: h.now + 60_000 });
    const held = await h.app.holdWindow('cmd-88');
    assert.equal(held.command.state, 'window-held');
    assert.equal(held.command.capacityChange, -1);
    assert.equal(held.line.remaining, 2);

    const approved = await h.app.approveCommand('cmd-88', { by: 'safety-lead' });
    assert.equal(approved.command.state, 'approved');
    assert.equal(approved.command.approvedBy, 'safety-lead');

    const view = await h.app.getAlert('THERMAL-204');
    assert.equal(view.alert.lineId, 'CELL-L3');
    assert.equal(view.commitment.commandId, 'cmd-88'); // 唯一承诺
    assert.equal(view.commitment.authorizedBy, 'safety-lead');
    assert.equal(view.commitment.state, 'approved');
    assert.equal(view.commitment.capacityChange, -1);
    assert.equal(view.line.remaining, 2);
  } finally {
    await h.cleanup();
  }
});

test('连续点击/消息重投：同一锁定命令并发 20 次只扣减一次', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h, { dailyQuota: 5 });
    await authorizedCommand(h, { commandId: 'cmd-1' });
    const results = await Promise.all(Array.from({ length: 20 }, () => h.app.holdWindow('cmd-1')));
    const real = results.filter((r) => !r.idempotentReplay);
    const replays = results.filter((r) => r.idempotentReplay);
    assert.equal(real.length, 1);
    assert.equal(replays.length, 19);
    assert.equal((await h.app.getLine('CELL-L3')).line.remaining, 4);
    // 再次重投仍是重放。
    const retry = await h.app.holdWindow('cmd-1');
    assert.equal(retry.idempotentReplay, true);
    assert.equal(retry.command.capacityChange, -1);
    assert.equal((await h.app.getLine('CELL-L3')).line.remaining, 4);
  } finally {
    await h.cleanup();
  }
});

test('并发授权只承认第一次结果，后来者不得冒名', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h);
    await h.app.submitCommand({ commandId: 'cmd-1', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'urgent-authorized' });
    const [first, ...rest] = await Promise.all([
      h.app.authorizeCommand('cmd-1', { authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: h.now + 60_000 }),
      ...Array.from({ length: 5 }, () =>
        h.app.authorizeCommand('cmd-1', { authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: h.now + 60_000 })),
    ]);
    assert.equal(first.command.authorizedBy, 'safety-lead');
    assert.ok(rest.every((r) => r.idempotentReplay));
    const view = await h.app.getAlert('THERMAL-204');
    assert.equal(view.commitment.authorizedBy, 'safety-lead');
  } finally {
    await h.cleanup();
  }
});

test('过期/越权/非法理由/关联错误的请求不改变可用量', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h, { dailyQuota: 2 });
    await h.app.submitCommand({ commandId: 'cmd-1', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'urgent-authorized' });

    await expectError(
      h.app.authorizeCommand('cmd-1', { authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: h.now - 1 }),
      'authorization-expired',
    );
    await expectError(
      h.app.authorizeCommand('cmd-1', { authorizedBy: 'maintenance', reasonCode: 'sensor-runaway', expiresAt: h.now + 1000 }),
      'unauthorized',
    );
    await expectError(
      h.app.authorizeCommand('cmd-1', { authorizedBy: 'safety-lead', reasonCode: 'nope', expiresAt: h.now + 1000 }),
      'reason-not-allowed',
    );
    // 授权后跨过有效期再锁定：临界区拦截。
    await h.app.authorizeCommand('cmd-1', { authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: h.now + 1000 });
    h.advance(1001);
    await expectError(h.app.holdWindow('cmd-1'), 'authorization-expired');

    // 关联到别的产线 / 为同一预警再开承诺：拒绝。
    await h.app.provisionLine({ lineId: 'CELL-L4', dailyQuota: 2 });
    await expectError(
      h.app.submitCommand({ commandId: 'cmd-x', alertId: 'THERMAL-204', lineId: 'CELL-L4', urgency: 'ordinary' }),
      'alert-line-mismatch',
    );
    await expectError(
      h.app.submitCommand({ commandId: 'cmd-y', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'ordinary' }),
      'alert-committed',
    );

    assert.equal((await h.app.getLine('CELL-L3')).line.remaining, 2);
    assert.equal((await h.app.getLine('CELL-L4')).line.remaining, 2);
  } finally {
    await h.cleanup();
  }
});

test('释放窗口原子退还配额，之后可再次锁定；重复释放不重复退还', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h, { dailyQuota: 1 });
    await authorizedCommand(h, { commandId: 'cmd-1' });
    await h.app.holdWindow('cmd-1');
    assert.equal((await h.app.getLine('CELL-L3')).line.remaining, 0);
    const released = await h.app.releaseWindow('cmd-1');
    assert.equal(released.command.state, 'authorized');
    assert.equal(released.line.remaining, 1);
    assert.equal((await Promise.all(Array.from({ length: 8 }, () => h.app.releaseWindow('cmd-1')))).filter((r) => !r.idempotentReplay).length, 0);
    assert.equal((await h.app.getLine('CELL-L3')).line.remaining, 1);
    // 新一轮窗口（授权仍在有效期内）。
    await h.app.holdWindow('cmd-1');
    assert.equal((await h.app.getLine('CELL-L3')).line.remaining, 0);
    const view = await h.app.getAlert('THERMAL-204');
    assert.equal(view.commitment.holdCount, 2);
    assert.equal(view.commitment.capacityChange, -1); // -1 +1 -1，当前仍占用一轮
  } finally {
    await h.cleanup();
  }
});

test('撤销已锁定窗口原子退还，预警可重新关联新命令', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h, { dailyQuota: 2 });
    await authorizedCommand(h, { commandId: 'cmd-1' });
    await h.app.holdWindow('cmd-1');
    const cancelled = await Promise.all(Array.from({ length: 6 }, (_, i) => h.app.cancelCommand('cmd-1', { by: i === 0 ? 'safety-lead' : 'safety-lead' })));
    assert.equal(cancelled.filter((r) => !r.idempotentReplay).length, 1);
    assert.equal((await h.app.getLine('CELL-L3')).line.remaining, 2);
    assert.equal((await h.app.getAlert('THERMAL-204')).commitment, null);
    // 预警重新走流程。
    await h.app.submitCommand({ commandId: 'cmd-2', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'ordinary' });
    await h.app.holdWindow('cmd-2');
    assert.equal((await h.app.getLine('CELL-L3')).line.remaining, 1);
  } finally {
    await h.cleanup();
  }
});

test('幂等键内容冲突被拒绝，且不产生任何事件', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h);
    await h.app.submitCommand({ commandId: 'cmd-1', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'ordinary' });
    await expectError(
      h.app.submitCommand({ commandId: 'cmd-1', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'urgent-authorized' }),
      'idempotency-conflict',
    );
    const seqBefore = h.store.state.seq;
    await expectError(
      h.app.submitCommand({ commandId: 'cmd-1', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'urgent-authorized' }),
      'idempotency-conflict',
    );
    assert.equal(h.store.state.seq, seqBefore);
  } finally {
    await h.cleanup();
  }
});

test('配额耗尽：第二个预警无法锁定，且不留任何占用', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h, { dailyQuota: 1, alertId: 'A1' });
    await h.app.registerAlert({ alertId: 'A2', lineId: 'CELL-L3', severity: 'warning' });
    await h.app.submitCommand({ commandId: 'c1', alertId: 'A1', lineId: 'CELL-L3', urgency: 'ordinary' });
    await h.app.submitCommand({ commandId: 'c2', alertId: 'A2', lineId: 'CELL-L3', urgency: 'ordinary' });
    await h.app.holdWindow('c1');
    await expectError(h.app.holdWindow('c2'), 'quota-exhausted');
    assert.equal((await h.app.getCommand('c2')).command.state, 'submitted');
    assert.equal((await h.app.getLine('CELL-L3')).line.remaining, 0);
  } finally {
    await h.cleanup();
  }
});

test('写入中断：重放耐久日志算回实际配额与状态', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h, { dailyQuota: 3 });
    await authorizedCommand(h, { commandId: 'cmd-1' });
    await h.app.holdWindow('cmd-1');
    await h.app.releaseWindow('cmd-1');
    const before = await h.app.getLine('CELL-L3');

    const reopened = await h.reopen();
    assert.equal(reopened.store.state.lines.get('CELL-L3').remaining, before.line.remaining);
    const view = reopened.app.getAlert('THERMAL-204');
    assert.equal(view.commitment.commandId, 'cmd-1');
    assert.equal(view.commitment.state, 'authorized');
    assert.equal(view.line.remaining, 3);
    // 恢复后继续追加，序号无缝衔接。
    await reopened.app.holdWindow('cmd-1');
    assert.equal(reopened.app.getLine('CELL-L3').line.remaining, 2);
    await reopened.store.close();
  } finally {
    await h.cleanup();
  }
});

test('末尾残行在启动时截断；残行中的“扣减”从未耐久，不影响配额', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h, { dailyQuota: 2 });
    await authorizedCommand(h, { commandId: 'cmd-1' });
    await h.app.holdWindow('cmd-1');
    assert.equal((await h.app.getLine('CELL-L3')).line.remaining, 1);
    await h.store.close();

    // 模拟 fsync 前崩溃：只写入半行、没有结尾换行。
    const logFile = join(h.dir, 'events.log');
    await fs.appendFile(logFile, '{"seq":7,"type":"WindowHeld","commandId":"phant');
    const reopened = await h.reopen();
    assert.equal(reopened.store.state.seq, 5); // 开通、登记、提交、授权、锁定
    const phantom = reopened.store.state.commands.get('phant');
    assert.equal(phantom, undefined);
    assert.equal(reopened.store.state.lines.get('CELL-L3').remaining, 1);
    // 截断后追加的新事件序号正确且可继续工作。
    await reopened.app.releaseWindow('cmd-1');
    assert.equal(reopened.store.state.lines.get('CELL-L3').remaining, 2);
    await reopened.store.close();
  } finally {
    await h.cleanup();
  }
});

test('日志中间出现坏行：拒绝启动而不是带着错误配额运行', async () => {
  const h = await createHarness();
  try {
    await seedLineAndAlert(h, { dailyQuota: 2 });
    await h.store.close();
    const logFile = join(h.dir, 'events.log');
    const raw = await fs.readFile(logFile, 'utf8');
    const [first, ...rest] = raw.split('\n');
    await fs.writeFile(logFile, [first, 'not-json', ...rest].join('\n'));
    await assert.rejects(h.reopen(), (e) => e.code === 'corrupt-log');
  } finally {
    await h.cleanup();
  }
});

test('上线演练：混合相同/不同预警的并发流量下配额恒等且承诺唯一', async () => {
  const h = await createHarness();
  try {
    await h.app.provisionLine({ lineId: 'CELL-L3', dailyQuota: 4 });
    const alertIds = Array.from({ length: 8 }, (_, i) => `A-${i}`);
    await Promise.all(alertIds.map((alertId) => h.app.registerAlert({ alertId, lineId: 'CELL-L3', severity: 'warning' })));

    // 每个预警提交命令，同时对同一命令制造重投。
    await Promise.all(
      alertIds.flatMap((alertId, i) => {
        const payload = { commandId: `cmd-${i}`, alertId, lineId: 'CELL-L3', urgency: 'ordinary' };
        return [h.app.submitCommand(payload), h.app.submitCommand({ ...payload }), h.app.submitCommand({ ...payload })];
      }),
    );

    // 对全部命令各点三次锁定；只有前 4 个预警能拿到窗口，其余稳定失败且不占用。
    const outcomes = (
      await Promise.allSettled(
        alertIds.flatMap((_, i) => Array.from({ length: 3 }, () => h.app.holdWindow(`cmd-${i}`))),
      )
    ).map((r) => r.value ?? null);
    const failures = outcomes.filter((r) => r === null);
    const heldAlerts = new Set(
      outcomes.filter((r) => r && !r.idempotentReplay && r.command.state === 'window-held').map((r) => r.command.alertId),
    );
    assert.equal(heldAlerts.size, 4);
    assert.equal(failures.length, 12); // 4 条拿不到窗口的命令 × 3 次点击
    const line = await h.app.getLine('CELL-L3');
    assert.equal(line.line.remaining, 0);
    assert.equal(line.line.holds, 4);

    // 失败者仍然失败，不会因为重试而挤入。
    const loser = alertIds
      .map((_, i) => `cmd-${i}`)
      .find((id) => h.store.state.commands.get(id).state === 'submitted');
    assert.ok(loser, '应当存在未拿到窗口的命令');
    await expectError(h.app.holdWindow(loser), 'quota-exhausted');

    // 每个预警只能核对到唯一一个命令。
    for (const alertId of alertIds) {
      const view = h.app.getAlert(alertId);
      assert.equal(view.commitment.commandId, `cmd-${alertIds.indexOf(alertId)}`);
    }
  } finally {
    await h.cleanup();
  }
});
