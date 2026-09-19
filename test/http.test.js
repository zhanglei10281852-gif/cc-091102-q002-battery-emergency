import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { createApp } from '../src/server.js';

async function setup() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'batt-http-'));
  const store = new EventStore(join(dir, 'events.log'));
  await store.load();
  const { server, service } = await createApp({ store });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return {
    port,
    service,
    close: () => new Promise((resolve) => server.close(() => store.close().then(resolve))),
  };
}

async function call(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('HTTP 全链路：登记、授权、锁定、核对唯一承诺与容量', async () => {
  const { port, close } = await setup();
  try {
    const health = await call(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'running');

    assert.equal((await call(port, 'POST', '/admin/lines', { lineId: 'CELL-L3', capacity: 3 })).status, 200);
    assert.equal((await call(port, 'POST', '/admin/reasons', { reasonCode: 'sensor-runaway', validUntil: '2099-01-01T00:00:00.000Z' })).status, 200);
    assert.equal((await call(port, 'POST', '/admin/grants', {
      grantId: 'g1', subject: 'safety-lead', level: 'urgent-authorized',
      reasonCode: 'sensor-runaway', expiresAt: '2099-01-01T00:00:00.000Z',
    })).status, 200);
    assert.equal((await call(port, 'POST', '/alerts', { alertId: 'THERMAL-W1', lineId: 'CELL-L3', level: 'urgent-authorized' })).status, 200);

    const bad = await call(port, 'POST', '/commands/authorize', { commandId: 'x1', alertId: 'THERMAL-W1', by: 'intruder', reasonCode: 'sensor-runaway' });
    assert.equal(bad.status, 403);
    assert.equal(bad.json.error, 'GRANT_MISSING');

    await call(port, 'POST', '/commands/authorize', { commandId: 'a1', alertId: 'THERMAL-W1', by: 'safety-lead', reasonCode: 'sensor-runaway' });
    const held1 = await call(port, 'POST', '/commands/hold', { commandId: 'h1', alertId: 'THERMAL-W1', by: 'safety-lead' });
    const held2 = await call(port, 'POST', '/commands/hold', { commandId: 'h1', alertId: 'THERMAL-W1', by: 'safety-lead' });
    assert.equal(held1.status, 200);
    assert.equal(held2.json.replayed, true);

    const alert = await call(port, 'GET', '/alerts/THERMAL-W1');
    assert.equal(alert.json.commitment.id, 'C-THERMAL-W1');
    assert.equal(alert.json.authorization.by, 'safety-lead');

    const commitment = await call(port, 'GET', '/commitments/C-THERMAL-W1');
    assert.equal(commitment.json.alertId, 'THERMAL-W1');
    assert.equal(commitment.json.capacityAfter, 2);

    const line = await call(port, 'GET', '/lines/CELL-L3');
    assert.equal(line.json.available, 2);

    // 关联错误：commandId 挂到别的预警
    const conflict = await call(port, 'POST', '/alerts', { alertId: 'THERMAL-W2', lineId: 'CELL-L3', level: 'urgent-authorized' });
    assert.equal(conflict.status, 200);
    const reused = await call(port, 'POST', '/commands/hold', { commandId: 'h1', alertId: 'THERMAL-W2', by: 'safety-lead' });
    assert.equal(reused.status, 409);
    assert.equal(reused.json.error, 'COMMAND_CONFLICT');
    assert.equal((await call(port, 'GET', '/lines/CELL-L3')).json.available, 2);
  } finally {
    await close();
  }
});

test('HTTP 错误体：坏 JSON、未知路由、缺少 commandId', async () => {
  const { port, close } = await setup();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/commands/hold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'BAD_JSON');

    assert.equal((await call(port, 'GET', '/nope')).status, 404);
    const noCmd = await call(port, 'POST', '/commands/hold', { alertId: 'X' });
    assert.equal(noCmd.status, 400);
    assert.equal(noCmd.json.error, 'COMMAND_REQUIRED');
  } finally {
    await close();
  }
});

test('独立进程入口可启动（npm start 同源）', async () => {
  // 仅验证 createApp 工厂在无 store 参数时自行落盘加载
  const dir = await fs.mkdtemp(join(tmpdir(), 'batt-proc-'));
  const oldEnv = process.env.EVENT_LOG;
  process.env.EVENT_LOG = join(dir, 'events.log');
  try {
    const app = await createApp({});
    assert.ok(app.service);
    assert.equal(app.store.state.seq, 0);
    await app.store.close();
  } finally {
    if (oldEnv === undefined) delete process.env.EVENT_LOG;
    else process.env.EVENT_LOG = oldEnv;
  }
});
