import { createServer } from 'node:http';
import { EventStore } from './store.js';
import { DecisionService } from './service.js';
import { DomainError } from './domain.js';

export async function createApp({ store, clock } = {}) {
  const eventStore = store ?? new EventStore(process.env.EVENT_LOG || './data/events.log');
  if (!store) await eventStore.load();
  const service = new DecisionService(eventStore, clock ? { clock } : {});

  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };

  const readJson = (request) =>
    new Promise((resolve, reject) => {
      let raw = '';
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1_048_576) {
          reject(new DomainError('PAYLOAD_TOO_LARGE', '请求体超过 1MiB', 413));
          request.destroy();
          return;
        }
        raw += chunk;
      });
      request.on('end', () => {
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new DomainError('BAD_JSON', '请求体不是合法 JSON', 400));
        }
      });
      request.on('error', reject);
    });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'GET' && (path === '/health' || path === '/')) {
        return send(response, 200, {
          service: 'battery-emergency',
          status: 'running',
          events: service.state.seq,
        });
      }

      if (request.method !== 'POST' && request.method !== 'GET') {
        throw new DomainError('METHOD_NOT_ALLOWED', '仅支持 GET/POST', 405);
      }

      // 登记接口
      if (request.method === 'POST' && path === '/admin/lines') {
        return send(response, 200, await service.registerLine(await readJson(request)));
      }
      if (request.method === 'POST' && path === '/admin/reasons') {
        return send(response, 200, await service.registerReason(await readJson(request)));
      }
      if (request.method === 'POST' && path === '/admin/grants') {
        return send(response, 200, await service.registerGrant(await readJson(request)));
      }
      if (request.method === 'POST' && path === '/alerts') {
        return send(response, 200, await service.registerAlert(await readJson(request)));
      }

      // 决策命令：/commands/:action
      const cmdMatch = path.match(/^\/commands\/([a-z-]+)$/);
      if (request.method === 'POST' && cmdMatch) {
        return send(response, 200, await service.dispatch(cmdMatch[1], await readJson(request)));
      }

      // 核对接口
      let m;
      if (request.method === 'GET' && (m = path.match(/^\/alerts\/(.+)$/))) {
        const view = service.getAlert(decodeURIComponent(m[1]));
        if (!view) throw new DomainError('ALERT_NOT_FOUND', '未知预警编号', 404);
        return send(response, 200, view);
      }
      if (request.method === 'GET' && (m = path.match(/^\/lines\/(.+)$/))) {
        const line = service.getLine(decodeURIComponent(m[1]));
        if (!line) throw new DomainError('LINE_NOT_FOUND', '未知产线', 404);
        return send(response, 200, line);
      }
      if (request.method === 'GET' && (m = path.match(/^\/commitments\/(.+)$/))) {
        const commitment = service.getCommitment(decodeURIComponent(m[1]));
        if (!commitment) throw new DomainError('COMMITMENT_NOT_FOUND', '未知承诺编号', 404);
        return send(response, 200, commitment);
      }

      throw new DomainError('NOT_FOUND', `无此路由: ${path}`, 404);
    } catch (err) {
      if (err instanceof DomainError) {
        return send(response, err.status, { error: err.code, message: err.message });
      }
      return send(response, 500, { error: 'INTERNAL', message: String(err?.message || err) });
    }
  });

  return { server, service, store: eventStore };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  const { server, store } = await createApp();
  server.listen(port, () => {
    console.log(JSON.stringify({ service: 'battery-emergency', port, events: store.state.seq, log: store.file }));
  });
  const shutdown = async () => {
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
