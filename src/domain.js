import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export const urgencyLevels = ['ordinary', 'urgent-authorized'];

// submitted  → 预警已登记
// authorized → 例外已授权（授权人/理由/有效期已记录，尚未占用配额）
// window-held→ 检查窗口已锁定（产线可用量已扣减，每预警唯一承诺）
// approved   → 窗口内检查结论已确认（仍占配额）
// cancelled  → 授权被撤销（如已锁定则回补配额）
// released   → 窗口释放，配额回补，终态
export const requestStates = [
  'submitted',
  'authorized',
  'window-held',
  'approved',
  'cancelled',
  'released',
];

export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export function createInitialState() {
  return {
    seq: 0,
    lastHash: GENESIS_HASH,
    lines: new Map(),
    reasons: new Map(),
    grants: new Map(),
    alerts: new Map(),
    commands: new Map(),
    events: [],
  };
}

function recordCapacity(alert, line, delta, type, at, extra = {}) {
  const capacityBefore = line.available;
  line.available += delta;
  const change = {
    type,
    at,
    delta,
    capacityBefore,
    capacityAfter: line.available,
    ...extra,
  };
  alert.changes.push(change);
  return change;
}

// 纯函数：事件 → 状态。运行期与崩溃恢复期使用同一条重放路径，
// 因此“从耐久记录算回实际配额”和在线看到的结果永远一致。
export function applyEvent(state, evt) {
  const p = evt.payload;
  switch (evt.type) {
    case 'line-registered':
      state.lines.set(p.lineId, {
        lineId: p.lineId,
        capacity: p.capacity,
        available: p.capacity,
      });
      break;

    case 'reason-registered':
      state.reasons.set(p.reasonCode, {
        reasonCode: p.reasonCode,
        validUntil: p.validUntil,
      });
      break;

    case 'grant-registered':
      state.grants.set(p.grantId, {
        grantId: p.grantId,
        subject: p.subject,
        level: p.level,
        reasonCode: p.reasonCode,
        expiresAt: p.expiresAt,
      });
      break;

    case 'alert-registered':
      state.alerts.set(p.alertId, {
        alertId: p.alertId,
        lineId: p.lineId,
        level: p.level,
        demand: p.demand,
        state: 'submitted',
        registeredAt: p.at,
        authorizedBy: null,
        reasonCode: null,
        grantExpiresAt: null,
        reasonValidUntil: null,
        authorizedAt: null,
        commitmentId: null,
        heldAt: null,
        approvedAt: null,
        cancelledAt: null,
        releasedAt: null,
        changes: [],
      });
      break;

    case 'alert-authorized': {
      const alert = state.alerts.get(p.alertId);
      alert.state = 'authorized';
      alert.authorizedBy = p.by;
      alert.reasonCode = p.reasonCode;
      alert.grantExpiresAt = p.grantExpiresAt;
      alert.reasonValidUntil = p.reasonValidUntil;
      alert.authorizedAt = p.at;
      break;
    }

    case 'window-held': {
      const alert = state.alerts.get(p.alertId);
      const line = state.lines.get(p.lineId);
      recordCapacity(alert, line, p.delta, 'window-held', p.at, {
        commitmentId: p.commitmentId,
        by: p.by,
      });
      alert.state = 'window-held';
      alert.commitmentId = p.commitmentId;
      alert.heldAt = p.at;
      break;
    }

    case 'alert-approved': {
      const alert = state.alerts.get(p.alertId);
      alert.state = 'approved';
      alert.approvedAt = p.at;
      alert.approvedBy = p.by;
      break;
    }

    case 'alert-cancelled': {
      const alert = state.alerts.get(p.alertId);
      if (p.delta !== 0) {
        const line = state.lines.get(alert.lineId);
        recordCapacity(alert, line, p.delta, 'alert-cancelled', p.at, {
          commitmentId: alert.commitmentId,
          by: p.by,
        });
      }
      alert.state = 'cancelled';
      alert.cancelledAt = p.at;
      alert.cancelledBy = p.by;
      break;
    }

    case 'window-released': {
      const alert = state.alerts.get(p.alertId);
      const line = state.lines.get(p.lineId);
      recordCapacity(alert, line, p.delta, 'window-released', p.at, {
        commitmentId: p.commitmentId,
        by: p.by,
      });
      alert.state = 'released';
      alert.releasedAt = p.at;
      alert.releasedBy = p.by;
      break;
    }

    case 'command-handled':
      state.commands.set(p.commandId, p);
      break;

    default:
      throw new DomainError('UNKNOWN_EVENT', `未知事件类型: ${evt.type}`, 500);
  }

  state.seq = evt.seq;
  state.lastHash = evt.hash;
  state.events.push(evt);
  return state;
}

export function alertView(state, alertId) {
  const alert = state.alerts.get(alertId);
  if (!alert) return null;
  const line = state.lines.get(alert.lineId);
  return {
    alertId: alert.alertId,
    lineId: alert.lineId,
    level: alert.level,
    demand: alert.demand,
    state: alert.state,
    registeredAt: alert.registeredAt,
    authorization: alert.authorizedBy
      ? {
          by: alert.authorizedBy,
          reasonCode: alert.reasonCode,
          grantExpiresAt: new Date(alert.grantExpiresAt).toISOString(),
          reasonValidUntil: new Date(alert.reasonValidUntil).toISOString(),
          at: alert.authorizedAt,
        }
      : null,
    commitment: alert.commitmentId
      ? {
          id: alert.commitmentId,
          heldAt: alert.heldAt,
          releasedAt: alert.releasedAt,
          delta: -alert.demand,
        }
      : null,
    capacityChanges: alert.changes,
    line: {
      lineId: line.lineId,
      capacity: line.capacity,
      available: line.available,
    },
  };
}
