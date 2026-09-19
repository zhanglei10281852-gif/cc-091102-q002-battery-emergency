// 服务入口：装配事件存储（本地耐久日志）、授权策略、决策应用与 HTTP 服务。
// 运行数据默认写入项目本地 data/events.log，随 .gitignore 留在本机，不外发。

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createEventStore } from './store.js';
import { createApplication } from './app.js';
import { createHttpServer } from './http.js';
import { loadPolicy } from './permissions.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.EVENT_LOG_FILE
  ? resolve(process.env.EVENT_LOG_FILE)
  : resolve(here, '..', 'data', 'events.log');
const port = Number(process.env.PORT || 8080);

const policy = loadPolicy();
const store = await createEventStore({ file: dataFile });
const app = createApplication({ store, policy });
const server = createHttpServer(app);

await new Promise((listen) => server.listen(port, listen));
console.log(JSON.stringify({ service: 'battery-emergency', status: 'running', port, eventLog: dataFile }));

async function shutdown(signal) {
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  server.close();
  await store.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
