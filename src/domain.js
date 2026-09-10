export const urgencyLevels = ['ordinary', 'urgent-authorized'];
export const requestStates = ['submitted', 'authorized', 'window-held', 'approved', 'cancelled'];

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
