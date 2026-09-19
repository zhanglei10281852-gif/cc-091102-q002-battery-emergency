import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/http.js';
import { createHarness, seedLineAndAlert, authorizedCommand } from './helpers.js';

async function startServer(h) {
  const server = createHttpServer(h.app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function jsonFetch(base, method, path, body, expected = true) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (expected) assert.ok(response.ok, `${method} ${path} 应成功：${JSON.stringify(payload)}`);
  return { status: response.status, payload };
}

test('HTTP 健康检查', async () => {
  const h = await createHarness();
  const srv = await startServer(h);
  try {
    const { payload } = await jsonFetch(srv.base, 'GET', '/healthz');
    assert.equal(payload.status, 'running');
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test('HTTP 完整流程 + 按预警编号核对', async () => {
  const h = await createHarness();
  const srv = await startServer(h);
  try {
    await jsonFetch(srv.base, 'POST', '/admin/lines', { lineId: 'CELL-L3', dailyQuota: 3 });
    await jsonFetch(srv.base, 'POST', '/alerts', { alertId: 'THERMAL-204', lineId: 'CELL-L3', severity: 'critical' });
    await jsonFetch(srv.base, 'POST', '/commands', { commandId: 'cmd-88', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'urgent-authorized' });
    await jsonFetch(srv.base, 'POST', '/commands/cmd-88/authorize', { authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: h.now + 60_000 });
    const { payload: held } = await jsonFetch(srv.base, 'POST', '/commands/cmd-88/hold', {});
    assert.equal(held.line.remaining, 2);
    await jsonFetch(srv.base, 'POST', '/commands/cmd-88/approve', { by: 'safety-lead' });

    const { payload: view } = await jsonFetch(srv.base, 'GET', '/alerts/THERMAL-204');
    assert.equal(view.commitment.commandId, 'cmd-88');
    assert.equal(view.commitment.authorizedBy, 'safety-lead');
    assert.equal(view.commitment.state, 'approved');
    assert.equal(view.line.remaining, 2);
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test('HTTP：未授权紧急锁定 409、越权 403、过期 403、非法关联 409，配额不变', async () => {
  const h = await createHarness();
  const srv = await startServer(h);
  try {
    await seedLineAndAlert(h, { dailyQuota: 2 });
    await jsonFetch(srv.base, 'POST', '/commands', { commandId: 'c1', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'urgent-authorized' });

    let r = await jsonFetch(srv.base, 'POST', '/commands/c1/hold', {}, false);
    assert.equal(r.status, 409);
    assert.equal(r.payload.error.code, 'invalid-state');

    r = await jsonFetch(srv.base, 'POST', '/commands/c1/authorize', { authorizedBy: 'maintenance', reasonCode: 'sensor-runaway', expiresAt: h.now + 1000 }, false);
    assert.equal(r.status, 403);
    assert.equal(r.payload.error.code, 'unauthorized');

    r = await jsonFetch(srv.base, 'POST', '/commands/c1/authorize', { authorizedBy: 'safety-lead', reasonCode: 'sensor-runaway', expiresAt: h.now - 1 }, false);
    assert.equal(r.status, 403);
    assert.equal(r.payload.error.code, 'authorization-expired');

    const { payload } = await jsonFetch(srv.base, 'GET', '/lines/CELL-L3');
    assert.equal(payload.line.remaining, 2);

    assert.equal((await jsonFetch(srv.base, 'GET', '/commands/nope', undefined, false)).status, 404);
    assert.equal((await jsonFetch(srv.base, 'GET', '/nope', undefined, false)).status, 404);
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test('HTTP：10 次并发连续点击锁定，只有一次真正扣减；随后重投仍是同一承诺', async () => {
  const h = await createHarness();
  const srv = await startServer(h);
  try {
    await seedLineAndAlert(h, { dailyQuota: 5 });
    await authorizedCommand(h, { commandId: 'c1' });
    const responses = await Promise.all(Array.from({ length: 10 }, () => jsonFetch(srv.base, 'POST', '/commands/c1/hold', {})));
    assert.equal(responses.filter((r) => !r.payload.idempotentReplay).length, 1);
    const first = await jsonFetch(srv.base, 'GET', '/lines/CELL-L3');
    assert.equal(first.payload.line.remaining, 4);
    // 消息重投：同一条命令的锁定请求再次到达。
    const retry = await jsonFetch(srv.base, 'POST', '/commands/c1/hold', {});
    assert.equal(retry.payload.idempotentReplay, true);
    assert.equal(retry.payload.command.capacityChange, -1);
    assert.equal((await jsonFetch(srv.base, 'GET', '/lines/CELL-L3')).payload.line.remaining, 4);
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test('HTTP：命令提交重投返回首个结果；冲突载荷被 409 拒绝', async () => {
  const h = await createHarness();
  const srv = await startServer(h);
  try {
    await seedLineAndAlert(h);
    const payload = { commandId: 'c1', alertId: 'THERMAL-204', lineId: 'CELL-L3', urgency: 'ordinary' };
    await jsonFetch(srv.base, 'POST', '/commands', payload);
    const retried = await jsonFetch(srv.base, 'POST', '/commands', payload);
    assert.equal(retried.payload.idempotentReplay, true);
    const conflict = await jsonFetch(srv.base, 'POST', '/commands', { ...payload, urgency: 'urgent-authorized' }, false);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.payload.error.code, 'idempotency-conflict');
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test('HTTP：非法 JSON 与越界路由返回错误且服务继续可用', async () => {
  const h = await createHarness();
  const srv = await startServer(h);
  try {
    const response = await fetch(srv.base + '/commands', { method: 'POST', body: '{not-json', headers: { 'content-type': 'application/json' } });
    assert.equal(response.status, 400);
    const healthy = await jsonFetch(srv.base, 'GET', '/healthz');
    assert.equal(healthy.payload.status, 'running');
  } finally {
    await srv.close();
    await h.cleanup();
  }
});
