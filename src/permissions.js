// 授权策略：谁能批准哪条产线、哪一级别的例外，以及允许使用的理由代码。
// 默认策略内置；如需使用本地凭据文件，通过 AUTH_POLICY_FILE 指向 JSON。
// 运行数据和授权凭据留在本地（见 README）。
//
// principals: {
//   'safety-lead': { levels: ['urgent-authorized'], lines: ['*'] },
//   'line-foreman': { levels: ['urgent-authorized'], lines: ['CELL-L3'] },
// }
// lines: ['*'] 表示全部产线；levels 为空表示无紧急授权资格。

import { readFileSync } from 'node:fs';

export const DEFAULT_POLICY = {
  principals: {
    'safety-lead': { levels: ['urgent-authorized'], lines: ['*'] },
    'cell-foreman': { levels: ['urgent-authorized'], lines: ['CELL-L3'] },
    'maintenance': { levels: [], lines: ['CELL-L3'] },
  },
  reasonCodes: ['sensor-runaway', 'thermal-spread', 'gas-detection', 'cooling-failure'],
};

export function loadPolicy(env = process.env) {
  if (env.AUTH_POLICY_FILE) {
    const parsed = JSON.parse(readFileSync(env.AUTH_POLICY_FILE, 'utf8'));
    return normalizePolicy(parsed);
  }
  return DEFAULT_POLICY;
}

export function normalizePolicy(raw) {
  const principals = {};
  for (const [name, grant] of Object.entries(raw?.principals ?? {})) {
    principals[name] = {
      levels: Array.isArray(grant?.levels) ? [...grant.levels] : [],
      lines: Array.isArray(grant?.lines) ? [...grant.lines] : [],
    };
  }
  return {
    principals,
    reasonCodes: Array.isArray(raw?.reasonCodes) ? [...raw.reasonCodes] : [],
  };
}
