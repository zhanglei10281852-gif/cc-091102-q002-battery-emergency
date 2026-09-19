// HTTP 适配层：把决策服务暴露为 JSON API。
// 所有写接口按资源派生幂等键（相同命令重投/并发只产生一次副作用），
// 领域错误映射为合适的 4xx，配额永不因被拒绝的请求发生变化。

import { createServer } from 'node:http';
import { DomainError } from './domain.js';

const STATUS_BY_CODE = {
  validation: 400,
  'not-found': 404,
  unauthorized: 403,
  'principal-unknown': 403,
  'reason-not-allowed': 403,
  'authorization-not-required': 403,
  'authorization-expired': 403,
  'alert-line-mismatch': 409,
  'alert-committed': 409,
  'command-exists': 409,
  'alert-exists': 409,
  'line-exists': 409,
  'invalid-state': 409,
  'already-authorized': 409,
  'quota-exhausted': 409,
  'idempotency-conflict': 409,
  'corrupt-log': 500,
};

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body);
}

async function readJson(request) {
  const limit = 64 * 1024;
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new DomainError('validation', '请求体超过 64KiB 限制');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('validation', '请求体不是合法 JSON');
  }
}

export function createHttpServer(app) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'GET' && path === '/healthz') {
        return send(response, 200, { service: 'battery-emergency', status: 'running' });
      }

      if (request.method === 'POST' && path === '/admin/lines') {
        const body = await readJson(request);
        return send(response, 201, await app.provisionLine(body));
      }

      if (request.method === 'POST' && path === '/alerts') {
        const body = await readJson(request);
        return send(response, 201, await app.registerAlert(body));
      }

      let match = path.match(/^\/alerts\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        return send(response, 200, await app.getAlert(decodeURIComponent(match[1])));
      }

      if (request.method === 'POST' && path === '/commands') {
        const body = await readJson(request);
        return send(response, 201, await app.submitCommand(body));
      }

      match = path.match(/^\/commands\/([^/]+)\/(authorize|hold|approve|release|cancel)$/);
      if (request.method === 'POST' && match) {
        const commandId = decodeURIComponent(match[1]);
        const action = match[2];
        const body = await readJson(request);
        const handler = {
          authorize: () => app.authorizeCommand(commandId, body),
          hold: () => app.holdWindow(commandId),
          approve: () => app.approveCommand(commandId, body),
          release: () => app.releaseWindow(commandId),
          cancel: () => app.cancelCommand(commandId, body),
        }[action];
        const result = await handler();
        return send(response, 200, result);
      }

      match = path.match(/^\/commands\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        return send(response, 200, await app.getCommand(decodeURIComponent(match[1])));
      }

      match = path.match(/^\/lines\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        return send(response, 200, await app.getLine(decodeURIComponent(match[1])));
      }

      return send(response, 404, { error: { code: 'not-found', message: '没有匹配的路由' } });
    } catch (error) {
      if (error instanceof DomainError) {
        const status = STATUS_BY_CODE[error.code] ?? 500;
        return send(response, status, { error: { code: error.code, message: error.message } });
      }
      console.error(error);
      return send(response, 500, { error: { code: 'internal', message: '服务内部错误' } });
    }
  });
}
