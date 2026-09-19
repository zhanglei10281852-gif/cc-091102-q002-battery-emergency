// 决策应用服务：把 HTTP 请求编排成“校验 -> 单条原子事件 -> 耐久落盘 -> 视图返回”。
// 幂等策略分两层：
//   1. 同 key 请求并发到达时共享同一个 Promise，只有第一个真正执行，其余拿到第一次结果；
//   2. 重投请求若事务已完成，则从耐久投影重放结果（载荷冲突直接拒绝）。
// hold/release/approve 等会迁移状态的操作即使绕过第一层（例如进程重启后的重投），
// 也会在串行事务内发现状态已迁移而重放，绝不重复扣减或重复退还。

import {
  DomainError,
  validateProvision,
  validateAlertRegistration,
  validateSubmission,
  validateAuthorization,
  validateHold,
  validateApproval,
  validateRelease,
  validateCancellation,
  viewCommand,
  viewLine,
  viewAlert,
} from './domain.js';

export function createApplication({ store, policy }) {
  const inflight = new Map(); // idempotency key -> Promise
  const completed = new Map(); // idempotency key -> { sig, result }

  // async：命中已完成记录的冲突时也要以 rejected promise 返回，调用方统一按异步错误处理。
  const coalesce = async (key, sig, produce) => {
    const done = completed.get(key);
    if (done) {
      if (sig !== undefined && done.sig !== sig) {
        throw new DomainError('idempotency-conflict', `幂等键 ${key} 绑定的请求内容与首次不一致`);
      }
      return { ...done.result, idempotentReplay: true };
    }
    const existing = inflight.get(key);
    if (existing) {
      // 并发副本共享同一次执行与首响内容，仅标记为幂等重放，便于调用方核对“只执行了一次”。
      return existing.then((result) => ({ ...result, idempotentReplay: true }));
    }
    const promise = (async () => {
      try {
        const result = await produce();
        completed.set(key, { sig, result });
        return result;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  const commandOutcome = (state, event) => {
    const command = state.commands.get(event.commandId);
    return {
      command: viewCommand(command),
      line: viewLine(state.lines.get(command.lineId)),
      eventSeq: event.seq,
    };
  };

  function replayCommand(state, command) {
    return {
      command: viewCommand(command),
      line: viewLine(state.lines.get(command.lineId)),
      idempotentReplay: true,
    };
  }

  // ---- 管理面：开通产线、登记预警 ----

  function provisionLine(input) {
    const normalized = validateProvision(input);
    const key = `provision:${normalized.lineId}`;
    return coalesce(key, JSON.stringify(normalized), () =>
      store.transact((state) => {
        const existing = state.lines.get(normalized.lineId);
        if (existing) {
          if (existing.dailyQuota !== normalized.dailyQuota) {
            throw new DomainError('idempotency-conflict', `产线 ${normalized.lineId} 已按不同配额开通`);
          }
          return { result: { line: viewLine(existing), idempotentReplay: true } };
        }
        return {
          event: { type: 'LineProvisioned', ...normalized },
          build: (s) => ({ line: viewLine(s.lines.get(normalized.lineId)) }),
        };
      }),
    );
  }

  function registerAlert(input) {
    const key = `register:${input?.alertId}`;
    return coalesce(key, JSON.stringify(input ?? {}), () =>
      store.transact((state) => {
        const existing = state.alerts.get(input?.alertId);
        if (existing) {
          const severity = input.severity ?? 'warning';
          if (input.lineId !== existing.lineId || severity !== existing.severity) {
            throw new DomainError('idempotency-conflict', `预警 ${input.alertId} 已按不同内容登记`);
          }
          return {
            result: {
              alert: { alertId: existing.alertId, lineId: existing.lineId, severity: existing.severity, at: existing.at },
              idempotentReplay: true,
            },
          };
        }
        const normalized = validateAlertRegistration(state, input);
        return {
          event: { type: 'AlertRegistered', ...normalized },
          build: (s) => ({
            alert: {
              alertId: normalized.alertId,
              lineId: normalized.lineId,
              severity: normalized.severity,
              at: s.alerts.get(normalized.alertId).at,
            },
          }),
        };
      }),
    );
  }

  // ---- 命令生命周期 ----

  function submitCommand(input) {
    const key = `submit:${input?.commandId}`;
    return coalesce(key, JSON.stringify(input ?? {}), () =>
      store.transact((state) => {
        const existing = state.commands.get(input?.commandId);
        if (existing) {
          if (
            existing.alertId !== input.alertId ||
            existing.lineId !== input.lineId ||
            existing.urgency !== input.urgency
          ) {
            throw new DomainError('idempotency-conflict', `命令 ${input.commandId} 已按不同内容提交`);
          }
          return { result: replayCommand(state, existing) };
        }
        const normalized = validateSubmission(state, input);
        return { event: { type: 'CommandSubmitted', ...normalized }, build: commandOutcome };
      }),
    );
  }

  function authorizeCommand(commandId, body) {
    const key = `authorize:${commandId}`;
    return coalesce(key, JSON.stringify(body ?? {}), () =>
      store.transact((state, now) => {
        const existing = state.commands.get(commandId);
        if (existing && existing.state !== 'submitted') {
          if (existing.state === 'cancelled') {
            throw new DomainError('invalid-state', '命令已撤销，不能再授权');
          }
          if (existing.authorizedBy !== body?.authorizedBy) {
            throw new DomainError('already-authorized', `命令 ${commandId} 已由 ${existing.authorizedBy} 授权`);
          }
          return { result: replayCommand(state, existing) };
        }
        // 占用前验证：权限、产线范围、理由白名单、有效期全部在事件追加之前完成。
        const normalized = validateAuthorization(state, commandId, body, now, policy);
        return { event: { type: 'Authorized', ...normalized }, build: commandOutcome };
      }),
    );
  }

  function holdWindow(commandId) {
    // 不做进程内合并：并发重复请求在串行事务内排队，第一个扣减，其余重放第一次结果。
    return store.transact((state, now) => {
      const command = state.commands.get(commandId);
      if (!command) throw new DomainError('not-found', `命令 ${commandId} 不存在`);
      if (command.state === 'window-held' || command.state === 'approved') {
        return { result: replayCommand(state, command) };
      }
      validateHold(state, commandId, now);
      return { event: { type: 'WindowHeld', commandId }, build: commandOutcome };
    });
  }

  function approveCommand(commandId, body) {
    const key = `approve:${commandId}`;
    return coalesce(key, JSON.stringify(body ?? {}), () =>
      store.transact((state) => {
        const existing = state.commands.get(commandId);
        if (existing?.state === 'approved') {
          if (existing.approvedBy !== body?.by) {
            throw new DomainError('idempotency-conflict', `命令已由 ${existing.approvedBy} 批准`);
          }
          return { result: replayCommand(state, existing) };
        }
        validateApproval(state, commandId);
        if (!body?.by) throw new DomainError('validation', '缺少批准人 by');
        return { event: { type: 'Approved', commandId, by: body.by }, build: commandOutcome };
      }),
    );
  }

  function releaseWindow(commandId) {
    return store.transact((state) => {
      const command = state.commands.get(commandId);
      if (!command) throw new DomainError('not-found', `命令 ${commandId} 不存在`);
      // 已释放（authorized 且历史上锁定过）：重放，不重复退还配额。
      if (command.state === 'authorized' && command.holdCount > 0) {
        return { result: replayCommand(state, command) };
      }
      validateRelease(state, commandId);
      return { event: { type: 'Released', commandId }, build: commandOutcome };
    });
  }

  function cancelCommand(commandId, body) {
    const key = `cancel:${commandId}`;
    return coalesce(key, JSON.stringify(body ?? {}), () =>
      store.transact((state) => {
        const existing = state.commands.get(commandId);
        if (existing?.state === 'cancelled') {
          if (existing.cancelledBy !== body?.by) {
            throw new DomainError('idempotency-conflict', `命令已由 ${existing.cancelledBy} 撤销`);
          }
          return { result: replayCommand(state, existing) };
        }
        validateCancellation(state, commandId);
        if (!body?.by) throw new DomainError('validation', '缺少撤销人 by');
        // 撤销已锁定窗口时，容量退还与状态迁移写入同一条事件。
        const capacityRefund = existing.state === 'window-held';
        return { event: { type: 'Cancelled', commandId, by: body.by, capacityRefund }, build: commandOutcome };
      }),
    );
  }

  // ---- 只读核对视图：值班主管按预警编号核对唯一承诺、授权人和容量变化 ----

  function getAlert(alertId) {
    const view = viewAlert(store.state, alertId);
    if (!view) throw new DomainError('not-found', `预警 ${alertId} 未登记`);
    return view;
  }

  function getCommand(commandId) {
    const command = store.state.commands.get(commandId);
    if (!command) throw new DomainError('not-found', `命令 ${commandId} 不存在`);
    return replayCommand(store.state, command);
  }

  function getLine(lineId) {
    const line = store.state.lines.get(lineId);
    if (!line) throw new DomainError('not-found', `产线 ${lineId} 尚未开通`);
    return { line: viewLine(line) };
  }

  return {
    provisionLine,
    registerAlert,
    submitCommand,
    authorizeCommand,
    holdWindow,
    approveCommand,
    releaseWindow,
    cancelCommand,
    getAlert,
    getCommand,
    getLine,
  };
}
