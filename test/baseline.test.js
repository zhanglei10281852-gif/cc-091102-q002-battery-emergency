import test from 'node:test'; import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; import { requestStates } from '../src/domain.js';
test('预警样例具备授权上下文', async () => { const item=JSON.parse(await readFile(new URL('../fixtures/incident.json', import.meta.url))); assert.ok(item.alertId); assert.ok(item.authorizedBy); assert.ok(requestStates.includes(item.state)); });
