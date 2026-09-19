// 电芯热失控预警处置领域模型。
// 纯函数、无 I/O：状态只能由耐久事件归约得到，容量变化与状态迁移绑定在同一条事件上，
// 这样写入中断后重放事件即可算回真实配额，且不可能出现“状态已迁移、配额未变”的撕裂。

export const urgencyLevels = ['ordinary', 'urgent-authorized'];
export const requestStates = ['submitted', 'authorized', 'window-held', 'approved', 'cancelled'];
export const alertSeverities = ['advisory', 'warning', 'critical'];

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DomainError(code, message);
}

export function createProjection() {
  return {
    seq: 0,
    lines: new Map(),       // lineId -> {lineId, dailyQuota, remaining, holds, refunds}
    alerts: new Map(),      // alertId -> {alertId, lineId, severity, at, commandId}
    commands: new Map(),    // commandId -> command
    commitments: new Map(), // alertId -> commandId（仅活跃承诺，cancelled 后移除）
  };
}

// 单条事件原子表达“状态迁移 + 容量变化”：
//   WindowHeld            配额 -1
//   Released              配额 +1（窗口提前释放，命令回到 authorized 可再次锁定）
//   Cancelled.capacityRefund=true 时配额 +1（撤销一条已锁定的命令）
export function applyEvent(state, event) {
  if (event.seq !== state.seq + 1) {
    fail('corrupt-log', `事件序号不连续：期望 ${state.seq + 1}，实际 ${event.seq}`);
  }

  switch (event.type) {
    case 'LineProvisioned': {
      if (state.lines.has(event.lineId)) fail('line-exists', `产线 ${event.lineId} 已存在`);
      state.lines.set(event.lineId, {
        lineId: event.lineId,
        dailyQuota: event.dailyQuota,
        remaining: event.dailyQuota,
        holds: 0,
        refunds: 0,
      });
      break;
    }
    case 'AlertRegistered': {
      if (state.alerts.has(event.alertId)) fail('alert-exists', `预警 ${event.alertId} 已登记`);
      if (!state.lines.has(event.lineId)) fail('not-found', `产线 ${event.lineId} 尚未开通`);
      state.alerts.set(event.alertId, {
        alertId: event.alertId,
        lineId: event.lineId,
        severity: event.severity,
        at: event.at,
        commandId: null,
      });
      break;
    }
    case 'CommandSubmitted': {
      if (state.commands.has(event.commandId)) fail('command-exists', `命令 ${event.commandId} 已存在`);
      const alert = state.alerts.get(event.alertId)
        ?? fail('not-found', `预警 ${event.alertId} 未登记`);
      if (alert.lineId !== event.lineId) fail('alert-line-mismatch', '命令产线与预警登记产线不一致');
      if (!state.lines.has(event.lineId)) fail('not-found', `产线 ${event.lineId} 尚未开通`);
      if (state.commitments.has(event.alertId)) {
        fail('alert-committed', `预警 ${event.alertId} 已存在活跃承诺 ${state.commitments.get(event.alertId)}`);
      }
      const command = {
        commandId: event.commandId,
        alertId: event.alertId,
        lineId: event.lineId,
        urgency: event.urgency,
        state: 'submitted',
        at: event.at,
        authorizedBy: null,
        reasonCode: null,
        expiresAt: null,
        authorizedAt: null,
        approvedBy: null,
        cancelledBy: null,
        holdCount: 0,
        capacityChange: 0,
      };
      state.commands.set(event.commandId, command);
      alert.commandId = event.commandId;
      state.commitments.set(event.alertId, event.commandId);
      break;
    }
    case 'Authorized': {
      const command = state.commands.get(event.commandId)
        ?? fail('not-found', `命令 ${event.commandId} 不存在`);
      if (command.state !== 'submitted') fail('invalid-state', `命令处于 ${command.state}，不能授权`);
      command.state = 'authorized';
      command.authorizedBy = event.authorizedBy;
      command.reasonCode = event.reasonCode;
      command.expiresAt = event.expiresAt;
      command.authorizedAt = event.at;
      break;
    }
    case 'WindowHeld': {
      const command = state.commands.get(event.commandId)
        ?? fail('not-found', `命令 ${event.commandId} 不存在`);
      const line = state.lines.get(command.lineId);
      if (command.urgency === 'urgent-authorized') {
        if (command.state !== 'authorized') fail('invalid-state', '紧急命令必须先完成授权才能锁定窗口');
      } else if (command.state !== 'submitted' && command.state !== 'authorized') {
        fail('invalid-state', `命令处于 ${command.state}，不能锁定窗口`);
      }
      if (line.remaining <= 0) fail('quota-exhausted', `产线 ${line.lineId} 当日检查配额已用尽`);
      command.state = 'window-held';
      command.capacityChange -= 1;
      command.holdCount += 1;
      line.remaining -= 1;
      line.holds += 1;
      break;
    }
    case 'Approved': {
      const command = state.commands.get(event.commandId)
        ?? fail('not-found', `命令 ${event.commandId} 不存在`);
      if (command.state !== 'window-held') fail('invalid-state', `命令处于 ${command.state}，不能批准`);
      command.state = 'approved';
      command.approvedBy = event.by;
      break;
    }
    case 'Released': {
      const command = state.commands.get(event.commandId)
        ?? fail('not-found', `命令 ${event.commandId} 不存在`);
      const line = state.lines.get(command.lineId);
      if (command.state !== 'window-held') fail('invalid-state', `命令处于 ${command.state}，无需释放`);
      command.state = 'authorized';
      command.capacityChange += 1;
      line.remaining += 1;
      line.refunds += 1;
      break;
    }
    case 'Cancelled': {
      const command = state.commands.get(event.commandId)
        ?? fail('not-found', `命令 ${event.commandId} 不存在`);
      if (!['submitted', 'authorized', 'window-held'].includes(command.state)) {
        fail('invalid-state', `命令处于 ${command.state}，不能撤销`);
      }
      if (event.capacityRefund) {
        // 与状态迁移写入同一条事件：撤销与容量退还不可能只完成一半。
        if (command.state !== 'window-held') fail('corrupt-log', '只有已锁定窗口的命令才应退还配额');
        const line = state.lines.get(command.lineId);
        command.capacityChange += 1;
        line.remaining += 1;
        line.refunds += 1;
      } else if (command.state === 'window-held') {
        fail('corrupt-log', '撤销已锁定窗口的命令必须携带容量退还');
      }
      command.state = 'cancelled';
      command.cancelledBy = event.by;
      state.commitments.delete(command.alertId);
      const alert = state.alerts.get(command.alertId);
      if (alert) alert.commandId = null;
      break;
    }
    default:
      fail('corrupt-log', `未知事件类型 ${event.type}`);
  }
  // 状态迁移（含容量变化）与序号推进一起生效：任何分支失败都不会留下半应用的事件。
  state.seq = event.seq;
  return state;
}

export function replay(events) {
  const state = createProjection();
  for (const event of events) applyEvent(state, event);
  return state;
}

// ---- 占用前校验：权限、理由有效期、关联关系全部在追加任何事件之前完成 ----

export function validateProvision(input) {
  const dailyQuota = Number(input?.dailyQuota);
  if (!input?.lineId || typeof input.lineId !== 'string') fail('validation', '缺少 lineId');
  if (!Number.isInteger(dailyQuota) || dailyQuota < 0) fail('validation', 'dailyQuota 必须为非负整数');
  return { lineId: input.lineId, dailyQuota };
}

export function validateAlertRegistration(state, input) {
  if (!input?.alertId || typeof input.alertId !== 'string') fail('validation', '缺少 alertId');
  if (state.alerts.has(input.alertId)) fail('alert-exists', `预警 ${input.alertId} 已登记`);
  if (!input.lineId || typeof input.lineId !== 'string') fail('validation', '缺少 lineId');
  if (!state.lines.has(input.lineId)) fail('not-found', `产线 ${input.lineId} 尚未开通`);
  const severity = input.severity ?? 'warning';
  if (!alertSeverities.includes(severity)) fail('validation', `未知预警级别 ${severity}`);
  return { alertId: input.alertId, lineId: input.lineId, severity };
}

export function validateSubmission(state, input) {
  if (!input?.commandId || typeof input.commandId !== 'string') fail('validation', '缺少 commandId');
  if (!input.alertId || typeof input.alertId !== 'string') fail('validation', '缺少 alertId');
  if (!input.lineId || typeof input.lineId !== 'string') fail('validation', '缺少 lineId');
  if (!urgencyLevels.includes(input.urgency)) fail('validation', `未知紧急级别 ${input.urgency}`);
  const alert = state.alerts.get(input.alertId);
  if (!alert) fail('not-found', `预警 ${input.alertId} 未登记`);
  if (alert.lineId !== input.lineId) {
    fail('alert-line-mismatch', `预警属于 ${alert.lineId}，不能关联到 ${input.lineId}`);
  }
  const owner = state.commitments.get(input.alertId);
  if (owner && owner !== input.commandId) {
    fail('alert-committed', `预警 ${input.alertId} 已被命令 ${owner} 占用`);
  }
  return { commandId: input.commandId, alertId: input.alertId, lineId: input.lineId, urgency: input.urgency };
}

// policy 结构见 permissions.js：principal -> {levels, lines}，外加全局 reasonCodes 白名单。
export function validateAuthorization(state, commandId, input, now, policy) {
  const command = state.commands.get(commandId);
  if (!command) fail('not-found', `命令 ${commandId} 不存在`);
  if (command.state !== 'submitted') fail('invalid-state', `命令处于 ${command.state}，不能授权`);
  if (command.urgency !== 'urgent-authorized') {
    fail('authorization-not-required', '普通命令不占用紧急授权，无需授权凭据');
  }
  const principal = input?.authorizedBy;
  if (!principal || typeof principal !== 'string') fail('validation', '缺少 authorizedBy');
  const grant = policy.principals?.[principal];
  if (!grant) fail('principal-unknown', `授权人 ${principal} 不在权限名单内`);
  if (!grant.levels?.includes(command.urgency)) {
    fail('unauthorized', `${principal} 无权批准 ${command.urgency} 级别的例外`);
  }
  const scope = grant.lines ?? [];
  if (!scope.includes('*') && !scope.includes(command.lineId)) {
    fail('unauthorized', `${principal} 无权在产线 ${command.lineId} 批准例外`);
  }
  const reasonCode = input.reasonCode;
  if (!reasonCode || typeof reasonCode !== 'string') fail('validation', '缺少 reasonCode');
  if (!policy.reasonCodes?.includes(reasonCode)) fail('reason-not-allowed', `理由代码 ${reasonCode} 不受支持`);
  const expiresAt = normalizeExpiry(input.expiresAt);
  if (expiresAt <= now) fail('authorization-expired', '授权依据在占用前已过期');
  return { commandId, authorizedBy: principal, reasonCode, expiresAt };
}

export function normalizeExpiry(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  fail('validation', 'expiresAt 必须是毫秒时间戳或 ISO 时间字符串');
}

// 锁定窗口前最后一次核验：即使授权后经过了一段时间，也必须在扣减的同一临界区内确认未过期。
export function validateHold(state, commandId, now) {
  const command = state.commands.get(commandId);
  if (!command) fail('not-found', `命令 ${commandId} 不存在`);
  // 已占用/已批准视为同一轮锁定的重放，由调用方直接回放结果、不再次扣减。
  if (command.state === 'window-held' || command.state === 'approved') return command;
  if (command.urgency === 'urgent-authorized') {
    if (command.state !== 'authorized') fail('invalid-state', '紧急命令必须先授权再锁定');
    if (!command.authorizedBy || !command.expiresAt) fail('unauthorized', '缺少授权凭据');
    if (command.expiresAt <= now) fail('authorization-expired', '授权依据已过期，不得占用窗口');
  } else if (command.state !== 'submitted' && command.state !== 'authorized') {
    fail('invalid-state', `命令处于 ${command.state}，不能锁定窗口`);
  }
  const line = state.lines.get(command.lineId);
  if (!line) fail('not-found', `产线 ${command.lineId} 尚未开通`);
  if (line.remaining <= 0) fail('quota-exhausted', `产线 ${line.lineId} 配额已用尽`);
  return command;
}

export function validateApproval(state, commandId) {
  const command = state.commands.get(commandId);
  if (!command) fail('not-found', `命令 ${commandId} 不存在`);
  if (command.state !== 'window-held') fail('invalid-state', `命令处于 ${command.state}，不能批准`);
  return command;
}

export function validateRelease(state, commandId) {
  const command = state.commands.get(commandId);
  if (!command) fail('not-found', `命令 ${commandId} 不存在`);
  if (command.state !== 'window-held') fail('invalid-state', `命令处于 ${command.state}，没有可释放的窗口`);
  return command;
}

export function validateCancellation(state, commandId) {
  const command = state.commands.get(commandId);
  if (!command) fail('not-found', `命令 ${commandId} 不存在`);
  if (command.state === 'cancelled' || command.state === 'approved') {
    fail('invalid-state', `命令处于终态 ${command.state}，不能撤销`);
  }
  return command;
}

// ---- 只读视图：供值班主管按预警编号核对承诺、授权人与容量变化 ----

export function viewCommand(command) {
  return {
    commandId: command.commandId,
    alertId: command.alertId,
    lineId: command.lineId,
    urgency: command.urgency,
    state: command.state,
    at: command.at,
    authorizedBy: command.authorizedBy,
    reasonCode: command.reasonCode,
    expiresAt: command.expiresAt,
    authorizedAt: command.authorizedAt,
    approvedBy: command.approvedBy,
    cancelledBy: command.cancelledBy,
    holdCount: command.holdCount,
    capacityChange: command.capacityChange,
  };
}

export function viewAlert(state, alertId) {
  const alert = state.alerts.get(alertId);
  if (!alert) return null;
  const command = alert.commandId ? state.commands.get(alert.commandId) : null;
  const line = state.lines.get(alert.lineId);
  return {
    alert: { alertId: alert.alertId, lineId: alert.lineId, severity: alert.severity, at: alert.at },
    commitment: command
      ? {
          commandId: command.commandId,
          state: command.state,
          urgency: command.urgency,
          authorizedBy: command.authorizedBy,
          reasonCode: command.reasonCode,
          expiresAt: command.expiresAt,
          authorizedAt: command.authorizedAt,
          approvedBy: command.approvedBy,
          cancelledBy: command.cancelledBy,
          holdCount: command.holdCount,
          capacityChange: command.capacityChange,
        }
      : null,
    line: { lineId: line.lineId, dailyQuota: line.dailyQuota, remaining: line.remaining },
  };
}

export function viewLine(line) {
  return {
    lineId: line.lineId,
    dailyQuota: line.dailyQuota,
    remaining: line.remaining,
    holds: line.holds,
    refunds: line.refunds,
  };
}

// ---- baseline 兼容入口（历史调用形状：state.records / state.remaining / state.audit） ----
export function approve(state, command) {
  const record = { ...command, state: 'approved' };
  state.records.push(record);
  state.remaining -= 1;
  state.audit.push({ type: 'authorized', alertId: command.alertId, at: command.at });
  return record;
}

export function cancel(state, record) {
  record.state = 'cancelled';
  state.remaining += 1;
}
