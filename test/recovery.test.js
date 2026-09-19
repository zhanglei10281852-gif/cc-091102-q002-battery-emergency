import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { DecisionService } from '../src/service.js';
import { computeHash } from '../src/store.js';

const FUTURE = '2099-01-01T00:00:00.000Z';

async function boot(logPath, clock = () => Date.parse('2090-06-01T00:00:00Z')) {
  const store = new EventStore(logPath);
  await store.load();
  const service = new DecisionService(store, { clock });
  return { store, service };
}

test('重启重放：实际配额、授权人、承诺全部从耐久记录算回', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'batt-rec-'));
  const log = join(dir, 'events.log');

  {
    const { store, service } = await boot(log);
    await service.registerLine({ lineId: 'CELL-L3', capacity: 4 });
    await service.registerReason({ reasonCode: 'sensor-runaway', validUntil: FUTURE });
    await service.registerGrant({
      grantId: 'g', subject: 'safety-lead', level: 'urgent-authorized',
      reasonCode: 'sensor-runaway', expiresAt: FUTURE,
    });
    await service.registerAlert({ alertId: 'THERMAL-R1', lineId: 'CELL-L3', level: 'urgent-authorized', demand: 2 });
    await service.dispatch('authorize', { commandId: 'auth-r1', alertId: 'THERMAL-R1', by: 'safety-lead', reasonCode: 'sensor-runaway' });
    await service.dispatch('hold', { commandId: 'hold-r1', alertId: 'THERMAL-R1', by: 'safety-lead' });
    await store.close();
  }

  const { store, service } = await boot(log);
  assert.equal(service.getLine('CELL-L3').available, 2);
  const view = service.getAlert('THERMAL-R1');
  assert.equal(view.state, 'window-held');
  assert.equal(view.authorization.by, 'safety-lead');
  assert.equal(view.commitment.id, 'C-THERMAL-R1');
  assert.deepEqual(view.capacityChanges[0], {
    type: 'window-held', at: view.capacityChanges[0].at, delta: -2, capacityBefore: 4, capacityAfter: 2,
    commitmentId: 'C-THERMAL-R1', by: 'safety-lead',
  });

  // 重投锁定命令：识别为已处理，不重复扣减
  const retry = await service.dispatch('hold', { commandId: 'hold-r1', alertId: 'THERMAL-R1', by: 'safety-lead' });
  assert.equal(retry.replayed, true);
  assert.equal(service.getLine('CELL-L3').available, 2);
  await store.close();
});

test('写入中断：尾部半截记录被截断，已 fsync 的完整事件重放无损', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'batt-torn-'));
  const log = join(dir, 'events.log');

  {
    const { store, service } = await boot(log);
    await service.registerLine({ lineId: 'CELL-L3', capacity: 3 });
    await store.close();
  }

  // 模拟崩溃：往日志末尾追加一条完整记录和一条写了一半的记录
  const existing = (await fs.readFile(log, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const goodPayload = { lineId: 'CELL-L4', capacity: 5 };
  const good = {
    seq: 2,
    type: 'line-registered',
    payload: goodPayload,
    hash: computeHash(existing.at(-1).hash, 'line-registered', goodPayload),
  };
  await fs.appendFile(log, JSON.stringify(good) + '\n{"seq":3,"type":"line-regist');

  const store = new EventStore(log);
  await store.load();
  assert.equal(store.truncated, 1);
  assert.equal(store.state.lines.get('CELL-L4').available, 5);
  assert.equal(store.state.seq, 2);

  // 截断后新事件正常续链
  const service = new DecisionService(store, { clock: () => Date.now() });
  await service.registerLine({ lineId: 'CELL-L5', capacity: 9 });
  assert.equal(store.state.seq, 3);

  // 再启一个实例验证整条链完好
  await store.close();
  const again = new EventStore(log);
  await again.load();
  assert.equal(again.truncated, 0);
  assert.equal(again.state.seq, 3);
  assert.equal(again.state.lines.get('CELL-L5').available, 9);
});

test('日志被篡改：哈希链在破坏点之后停止重放', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'batt-tamper-'));
  const log = join(dir, 'events.log');
  {
    const { store, service } = await boot(log);
    await service.registerLine({ lineId: 'CELL-L3', capacity: 3 });
    await service.registerLine({ lineId: 'CELL-L4', capacity: 7 });
    await store.close();
  }
  const lines = (await fs.readFile(log, 'utf8')).trimEnd().split('\n');
  const tampered = JSON.parse(lines[0]);
  tampered.payload.capacity = 300; // 改容量但不重算哈希
  lines[0] = JSON.stringify(tampered);
  await fs.writeFile(log, lines.join('\n') + '\n');

  const store = new EventStore(log);
  await store.load();
  assert.equal(store.state.seq, 0);
  assert.equal(store.state.lines.size, 0);
});
