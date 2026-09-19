import { randomUUID } from 'node:crypto';
import { DomainError, urgencyLevels, alertView } from './domain.js';

const ACTION_EVENT = {
  authorize: 'alert-authorized',
  hold: 'window-held',
  approve: 'alert-approved',
  cancel: 'alert-cancelled',
  release: 'window-released',
};

// 决策服务。不变式：
//  1. 每条外部命令对应至多一个事件（commandId 内嵌在事件里），
//     重复/重投命令要么共享在途 Promise，要么在重放记录中被识别后原样返回。
//  2. 所有“校验 + 落盘”都在一条串行链上完成，授权、锁定、撤销、释放彼此原子衔接。
//  3. 任何校验失败都在 append 之前抛出，不产生事件、不改变产线可用量。
export class DecisionService {
  constructor(store, { clock = () => Date.now() } = {}) {
    this.store = store;
    this.state = store.state;
    this.clock = clock;
    this.chain = Promise.resolve();
    this.inflight = new Map();
  }

  get now() {
    return new Date(this.clock()).toISOString();
  }

  // 串行临界区：前一个命令落盘（或失败）之后，下一个才开始校验。
  _enqueue(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // 相同 commandId 并发到达：共享同一个 Promise，只执行第一次。
  dispatch(action, body) {
    if (!ACTION_EVENT[action]) throw new DomainError('UNKNOWN_ACTION', `未知命令: ${action}`, 404);
    const commandId = body?.commandId;
    if (!commandId) throw new DomainError('COMMAND_REQUIRED', '缺少 commandId', 400);

    const pending = this.inflight.get(commandId);
    if (pending) {
      return pending.then((result) => ({ ...result, deduplicated: true }));
    }
    const result = this._enqueue(() => this._execute(action, body));
    this.inflight.set(commandId, result);
    result.then(
      () => this.inflight.delete(commandId),
      () => this.inflight.delete(commandId),
    );
    return result;
  }

  _findCommand(commandId) {
    for (const evt of this.state.events) {
      if (evt.payload && evt.payload.commandId === commandId) return evt;
    }
    return null;
  }

  async _execute(action, body) {
    const commandId = body.commandId;
    const alertId = body.alertId;
    if (!alertId) throw new DomainError('ALERT_REQUIRED', '缺少 alertId', 400);

    // 崩溃重投：事件里已带有同一 commandId —— 不重放业务，返回持久化的第一次结果。
    const prior = this._findCommand(commandId);
    if (prior) {
      if (prior.type !== ACTION_EVENT[action] || prior.payload.alertId !== alertId) {
        throw new DomainError(
          'COMMAND_CONFLICT',
          `commandId ${commandId} 已用于不同的命令（预警 ${prior.payload.alertId}）`,
          409,
        );
      }
      return this._respond(action, alertId, commandId, true);
    }

    const at = this.now;
    const build = this._handlers[action].call(this, body, at);
    await this.store.append(build === null ? [] : [build]);
    return this._respond(action, alertId, commandId, false);
  }

  _handlers = {
    authorize(body, at) {
      const alert = this._requireAlert(body.alertId);
      if (alert.state !== 'submitted') {
        throw new DomainError('INVALID_STATE', `预警 ${alert.alertId} 当前为 ${alert.state}，不能授权`, 409);
      }
      const by = body.by;
      if (!by) throw new DomainError('SUBJECT_REQUIRED', '缺少授权人 by', 400);

      // 紧急突破：理由码本身必须先成立（存在且未过期），再核对授权是否覆盖该理由。
      let reasonValidUntil = null;
      if (alert.level === 'urgent-authorized') {
        if (!body.reasonCode) {
          throw new DomainError('REASON_REQUIRED', '紧急突破必须提供理由码', 400);
        }
        const reason = this.state.reasons.get(body.reasonCode);
        if (!reason) throw new DomainError('REASON_UNKNOWN', `理由码 ${body.reasonCode} 未登记`, 403);
        this._assertFresh(reason.validUntil, '理由依据', 403);
        reasonValidUntil = reason.validUntil;
      } else if (body.reasonCode) {
        const reason = this.state.reasons.get(body.reasonCode);
        if (!reason) throw new DomainError('REASON_UNKNOWN', `理由码 ${body.reasonCode} 未登记`, 403);
        this._assertFresh(reason.validUntil, '理由依据', 403);
        reasonValidUntil = reason.validUntil;
      }

      const grant = this._findGrant(by, alert.level, body.reasonCode ?? null);
      this._assertFresh(grant.expiresAt, '授权凭据', 403);

      // 快照授权时刻的有效期，事后可证明“批准时凭据确实未过期”。
      return this.store.buildEvent('alert-authorized', {
        commandId: body.commandId,
        alertId: alert.alertId,
        by,
        reasonCode: body.reasonCode ?? null,
        grantExpiresAt: grant.expiresAt,
        reasonValidUntil,
        at,
      });
    },

    hold(body, at) {
      const alert = this._requireAlert(body.alertId);
      if (alert.state === 'window-held' || alert.state === 'approved') {
        throw new DomainError('COMMITMENT_EXISTS', `预警 ${alert.alertId} 已有唯一承诺 ${alert.commitmentId}`, 409);
      }
      if (alert.state !== 'authorized') {
        throw new DomainError('INVALID_STATE', `预警 ${alert.alertId} 为 ${alert.state}，须先授权再锁定窗口`, 409);
      }
      if (body.by !== alert.authorizedBy) {
        throw new DomainError('SUBJECT_MISMATCH', '锁定窗口必须由原授权人执行', 403);
      }

      // 占用前再次验证：授权与理由在“扣减配额的这一刻”仍然有效。
      const grant = this._findGrant(alert.authorizedBy, alert.level, alert.reasonCode);
      this._assertFresh(grant.expiresAt, '授权凭据', 403);
      if (alert.reasonCode) {
        const reason = this.state.reasons.get(alert.reasonCode);
        if (!reason) throw new DomainError('REASON_UNKNOWN', `理由码 ${alert.reasonCode} 未登记`, 403);
        this._assertFresh(reason.validUntil, '理由依据', 403);
      }

      const line = this.state.lines.get(alert.lineId);
      if (line.available < alert.demand) {
        throw new DomainError(
          'QUOTA_EXHAUSTED',
          `产线 ${line.lineId} 可用 ${line.available}，本次需要 ${alert.demand}`,
          409,
        );
      }

      // 每预警唯一承诺：承诺编号由预警编号派生，状态机保证其只诞生一次。
      return this.store.buildEvent('window-held', {
        commandId: body.commandId,
        alertId: alert.alertId,
        lineId: alert.lineId,
        by: body.by,
        commitmentId: `C-${alert.alertId}`,
        delta: -alert.demand,
        at,
      });
    },

    approve(body, at) {
      const alert = this._requireAlert(body.alertId);
      if (alert.state !== 'window-held') {
        throw new DomainError('INVALID_STATE', `预警 ${alert.alertId} 为 ${alert.state}，须在已锁定窗口内确认`, 409);
      }
      if (body.by !== alert.authorizedBy) {
        throw new DomainError('SUBJECT_MISMATCH', '检查结论必须由窗口授权人确认', 403);
      }
      return this.store.buildEvent('alert-approved', {
        commandId: body.commandId,
        alertId: alert.alertId,
        by: body.by,
        at,
      });
    },

    cancel(body, at) {
      const alert = this._requireAlert(body.alertId);
      if (alert.state === 'cancelled' || alert.state === 'released') {
        throw new DomainError('INVALID_STATE', `预警 ${alert.alertId} 已终态（${alert.state}）`, 409);
      }
      if (body.by !== alert.authorizedBy) {
        throw new DomainError('SUBJECT_MISMATCH', '撤销必须由原授权人执行', 403);
      }
      // 已锁定则在同一事件里原子回补；仅授权未占用则 delta 为 0，容量不动。
      const refund = alert.state === 'window-held' || alert.state === 'approved' ? alert.demand : 0;
      return this.store.buildEvent('alert-cancelled', {
        commandId: body.commandId,
        alertId: alert.alertId,
        by: body.by,
        delta: refund,
        at,
      });
    },

    release(body, at) {
      const alert = this._requireAlert(body.alertId);
      if (alert.state !== 'approved' && alert.state !== 'window-held') {
        throw new DomainError('INVALID_STATE', `预警 ${alert.alertId} 为 ${alert.state}，无窗口可释放`, 409);
      }
      if (body.by !== alert.authorizedBy) {
        throw new DomainError('SUBJECT_MISMATCH', '释放必须由窗口授权人执行', 403);
      }
      return this.store.buildEvent('window-released', {
        commandId: body.commandId,
        alertId: alert.alertId,
        lineId: alert.lineId,
        by: body.by,
        commitmentId: alert.commitmentId,
        delta: alert.demand,
        at,
      });
    },
  };

  _requireAlert(alertId) {
    const alert = this.state.alerts.get(alertId);
    if (!alert) throw new DomainError('ALERT_NOT_FOUND', `未知预警编号: ${alertId}`, 404);
    return alert;
  }

  _findGrant(subject, level, reasonCode) {
    if (!urgencyLevels.includes(level)) {
      throw new DomainError('INVALID_LEVEL', `未知级别: ${level}`, 400);
    }
    for (const grant of this.state.grants.values()) {
      if (grant.subject !== subject || grant.level !== level) continue;
      if (grant.reasonCode !== null && grant.reasonCode !== reasonCode) continue;
      return grant;
    }
    throw new DomainError(
      'GRANT_MISSING',
      `${subject} 没有级别 ${level}${reasonCode ? `（理由 ${reasonCode}）` : ''}的有效授权`,
      403,
    );
  }

  _assertFresh(expiresAt, what, status) {
    if (new Date(expiresAt).getTime() <= this.clock()) {
      throw new DomainError('EXPIRED', `${what}已于 ${expiresAt} 过期`, status);
    }
  }

  _respond(action, alertId, commandId, replayed) {
    const view = alertView(this.state, alertId);
    const lastChange = view.capacityChanges[view.capacityChanges.length - 1] ?? null;
    return {
      result: 'accepted',
      replayed,
      commandId,
      action,
      alertId,
      alertState: view.state,
      authorization: view.authorization,
      commitment: view.commitment,
      capacityChange: lastChange && ['window-held', 'alert-cancelled', 'window-released'].includes(lastChange.type)
        ? {
            type: lastChange.type,
            delta: lastChange.delta,
            capacityBefore: lastChange.capacityBefore,
            capacityAfter: lastChange.capacityAfter,
          }
        : null,
      line: view.line,
    };
  }

  // —— 登记类接口（幂等：同键同值直接返回，键冲突报错） ——

  registerLine({ lineId, capacity }) {
    return this._enqueue(() => {
      if (!lineId) throw new DomainError('LINE_REQUIRED', '缺少 lineId', 400);
      if (!Number.isInteger(capacity) || capacity < 0) {
        throw new DomainError('INVALID_CAPACITY', 'capacity 必须为非负整数', 400);
      }
      const existing = this.state.lines.get(lineId);
      if (existing) {
        if (existing.capacity !== capacity) {
          throw new DomainError('LINE_CONFLICT', `产线 ${lineId} 已登记且配额不同`, 409);
        }
        return { result: 'accepted', idempotent: true, line: existing };
      }
      return this.store
        .append([this.store.buildEvent('line-registered', { lineId, capacity })])
        .then(() => ({ result: 'accepted', idempotent: false, line: this.state.lines.get(lineId) }));
    });
  }

  registerReason({ reasonCode, validUntil }) {
    return this._enqueue(() => {
      if (!reasonCode) throw new DomainError('REASON_REQUIRED', '缺少 reasonCode', 400);
      if (!validUntil) throw new DomainError('VALID_UNTIL_REQUIRED', '缺少 validUntil', 400);
      const existing = this.state.reasons.get(reasonCode);
      if (existing) {
        if (existing.validUntil !== validUntil) {
          throw new DomainError('REASON_CONFLICT', `理由 ${reasonCode} 已登记且有效期不同`, 409);
        }
        return { result: 'accepted', idempotent: true, reason: existing };
      }
      return this.store
        .append([this.store.buildEvent('reason-registered', { reasonCode, validUntil })])
        .then(() => ({ result: 'accepted', idempotent: false, reason: this.state.reasons.get(reasonCode) }));
    });
  }

  registerGrant({ grantId = null, subject, level, reasonCode = null, expiresAt }) {
    return this._enqueue(() => {
      if (!subject) throw new DomainError('SUBJECT_REQUIRED', '缺少 subject', 400);
      if (!urgencyLevels.includes(level)) throw new DomainError('INVALID_LEVEL', `未知级别: ${level}`, 400);
      if (!expiresAt) throw new DomainError('EXPIRES_AT_REQUIRED', '缺少 expiresAt', 400);
      const id = grantId ?? `G-${randomUUID()}`;
      const existing = this.state.grants.get(id);
      if (existing) {
        if (
          existing.subject !== subject ||
          existing.level !== level ||
          existing.reasonCode !== reasonCode ||
          existing.expiresAt !== expiresAt
        ) {
          throw new DomainError('GRANT_CONFLICT', `授权 ${id} 已登记且内容不同`, 409);
        }
        return { result: 'accepted', idempotent: true, grant: existing };
      }
      return this.store
        .append([
          this.store.buildEvent('grant-registered', {
            grantId: id,
            subject,
            level,
            reasonCode,
            expiresAt,
          }),
        ])
        .then(() => ({ result: 'accepted', idempotent: false, grant: this.state.grants.get(id) }));
    });
  }

  registerAlert({ alertId, lineId, level, demand = 1 }) {
    return this._enqueue(() => {
      if (!alertId) throw new DomainError('ALERT_REQUIRED', '缺少 alertId', 400);
      if (!lineId) throw new DomainError('LINE_REQUIRED', '缺少 lineId', 400);
      if (!urgencyLevels.includes(level)) throw new DomainError('INVALID_LEVEL', `未知级别: ${level}`, 400);
      if (!Number.isInteger(demand) || demand <= 0) throw new DomainError('INVALID_DEMAND', 'demand 必须为正整数', 400);
      if (!this.state.lines.has(lineId)) throw new DomainError('LINE_NOT_FOUND', `未知产线: ${lineId}`, 404);

      const existing = this.state.alerts.get(alertId);
      if (existing) {
        if (existing.lineId !== lineId || existing.level !== level || existing.demand !== demand) {
          throw new DomainError('ALERT_CONFLICT', `预警 ${alertId} 已登记且关联信息不同`, 409);
        }
        return { result: 'accepted', idempotent: true, alert: alertView(this.state, alertId) };
      }
      return this.store
        .append([
          this.store.buildEvent('alert-registered', {
            alertId,
            lineId,
            level,
            demand,
            at: this.now,
          }),
        ])
        .then(() => ({ result: 'accepted', idempotent: false, alert: alertView(this.state, alertId) }));
    });
  }

  getAlert(alertId) {
    return alertView(this.state, alertId);
  }

  getLine(lineId) {
    const line = this.state.lines.get(lineId);
    return line ? { ...line } : null;
  }

  getCommitment(commitmentId) {
    for (const alert of this.state.alerts.values()) {
      if (alert.commitmentId === commitmentId) {
        const change = alert.changes.find((c) => c.commitmentId === commitmentId && c.type === 'window-held');
        return {
          commitmentId,
          alertId: alert.alertId,
          lineId: alert.lineId,
          by: alert.authorizedBy,
          reasonCode: alert.reasonCode,
          grantExpiresAt: alert.grantExpiresAt,
          reasonValidUntil: alert.reasonValidUntil,
          delta: -alert.demand,
          capacityBefore: change?.capacityBefore ?? null,
          capacityAfter: change?.capacityAfter ?? null,
          heldAt: alert.heldAt,
          releasedAt: alert.releasedAt,
          state: alert.state,
        };
      }
    }
    return null;
  }
}
