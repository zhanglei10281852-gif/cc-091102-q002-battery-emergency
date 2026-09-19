import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventStore } from '../src/store.js';
import { createApplication } from '../src/app.js';
import { DEFAULT_POLICY } from '../src/permissions.js';

export async function createHarness({ policy = DEFAULT_POLICY, clock } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'battery-test-'));
  let now = 1_000_000;
  const getTime = clock ?? (() => now);
  const advance = (ms) => {
    now += ms;
  };
  const store = await createEventStore({ file: join(dir, 'events.log'), clock: getTime, logger: { warn() {}, log() {} } });
  const app = createApplication({ store, policy });
  return {
    dir,
    app,
    store,
    advance,
    get now() {
      return now;
    },
    async reopen() {
      await store.close();
      const reopened = await createEventStore({ file: join(dir, 'events.log'), clock: getTime, logger: { warn() {}, log() {} } });
      return { store: reopened, app: createApplication({ store: reopened, policy }) };
    },
    async cleanup() {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function seedLineAndAlert(h, { lineId = 'CELL-L3', dailyQuota = 2, alertId = 'THERMAL-204', severity = 'critical' } = {}) {
  await h.app.provisionLine({ lineId, dailyQuota });
  await h.app.registerAlert({ alertId, lineId, severity });
}

export async function authorizedCommand(h, { commandId = 'cmd-1', alertId = 'THERMAL-204', lineId = 'CELL-L3', urgency = 'urgent-authorized', authorizedBy = 'safety-lead', reasonCode = 'sensor-runaway', ttl = 60_000 } = {}) {
  await h.app.submitCommand({ commandId, alertId, lineId, urgency });
  await h.app.authorizeCommand(commandId, { authorizedBy, reasonCode, expiresAt: h.now + ttl });
  return commandId;
}
