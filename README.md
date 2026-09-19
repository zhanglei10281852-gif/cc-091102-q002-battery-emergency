# 电芯安全紧急检查

集团安全中心把电芯热失控预警接入统一处置的决策服务：从**预警登记**到**检查窗口释放**全流程留痕，值班主管可按预警编号核对唯一承诺、授权人和产线容量变化。

普通安排（`ordinary`）受产线日配额限制；紧急突破（`urgent-authorized`）必须关联已登记预警、持有授权人凭据且理由在有效期内。`fixtures/incident.json` 是一次重复审批事故的脱敏记录。

项目使用 Node.js 20+，不依赖外部软件或第三方包。运行数据（`data/events.log`）与授权凭据留在本地。

## 设计要点

- **事件溯源 + 原子事件**：每次状态迁移只追加一条不可变事件。扣减（`WindowHeld`）、退还（`Released`）以及“撤销持锁命令并退配额”（`Cancelled.capacityRefund`）都把**状态迁移与容量变化写在同一条事件里**，不可能只完成一半。
- **占用前验证**：授权时校验授权人资格、产线范围、理由代码白名单和有效期；锁定窗口的同一临界区内再次确认授权未过期。任何过期、越权、关联错误的请求都在校验阶段被拒，不产生事件、不改变可用量。
- **连续点击 / 消息重投不重复扣减**：同资源请求并发到达时共享第一次执行结果；绕过合并的重投（含进程重启后）在串行事务内发现状态已迁移即幂等重放。窗口按轮次（`holdCount`）区分：释放后再次锁定是合法新一轮。
- **唯一承诺**：一个预警同时只允许一条活跃命令占用；撤销后承诺释放，预警可关联新命令。
- **写入中断可恢复**：每条事件写入后 `fsync` 再更新内存；启动重放日志重建真实配额，末尾未耐久完成的残行截断后重放，日志中间损坏则拒绝启动，绝不带着错误配额运行。
- **可追责**：授权人、理由代码、有效期、批准人、撤销人与累计容量变化都随事件持久保存。

## 生命周期

```
登记预警 ── 提交命令 ── 授权(仅紧急) ── 锁定窗口(扣1) ── 批准
                             ▲              │
                             └── 释放窗口(退1)
                                            └── 撤销(持锁时退1，承诺释放)
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/lines` | 开通产线 `{lineId, dailyQuota}` |
| POST | `/alerts` | 登记预警 `{alertId, lineId, severity}` |
| GET | `/alerts/:alertId` | **按预警编号核对**：唯一承诺、授权人、理由、容量变化、产线余量 |
| POST | `/commands` | 提交命令 `{commandId, alertId, lineId, urgency}` |
| POST | `/commands/:id/authorize` | 紧急授权 `{authorizedBy, reasonCode, expiresAt}` |
| POST | `/commands/:id/hold` | 锁定检查窗口（普通直接锁；紧急须先授权且未过期） |
| POST | `/commands/:id/approve` | 批准已锁定窗口 `{by}` |
| POST | `/commands/:id/release` | 释放窗口并退还配额 |
| POST | `/commands/:id/cancel` | 撤销命令 `{by}`（持锁时原子退配额） |
| GET | `/commands/:id` | 命令详情与容量变化 |
| GET | `/lines/:lineId` | 产线配额视图 |
| GET | `/healthz` | 运行状态 |

冲突/重放返回带 `idempotentReplay: true` 的首个结果；载荷与首次不一致返回 `409 idempotency-conflict`。领域错误码包括 `authorization-expired`、`unauthorized`、`reason-not-allowed`、`alert-line-mismatch`、`alert-committed`、`quota-exhausted`、`invalid-state` 等。

## 运行

```bash
npm test                 # 35 项单元/并发/恢复/HTTP 集成测试
npm start                # 默认 data/events.log、端口 8080
PORT=8090 EVENT_LOG_FILE=/var/data/cell-events.log npm start
AUTH_POLICY_FILE=/etc/cell/policy.json npm start   # 自定义授权策略
```

授权策略文件形状：

```json
{
  "principals": { "safety-lead": { "levels": ["urgent-authorized"], "lines": ["*"] } },
  "reasonCodes": ["sensor-runaway", "thermal-spread"]
}
```

事件日志为每行一条 JSON（NDJSON），可直接归档与审计；**只追加、勿手工改写**，中间坏行会导致服务拒绝启动。
