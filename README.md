# 电芯安全紧急检查

安全部门通过本服务登记热失控预警，并在授权后为产线锁定检查窗口。普通安排受日配额限制，紧急突破必须关联预警和授权依据。`fixtures/incident.json` 是一次重复审批事故的脱敏记录。

项目使用 Node.js 20，不依赖外部软件。`npm test` 运行全部决策与恢复测试，`npm start` 启动服务（默认端口 8080）；运行数据和授权凭据应留在本地。

## 决策流程

```
登记 alert → 授权 authorize → 锁定窗口 hold → 确认 approve → 释放 release
                  └─ 未占用可撤销 cancel（容量不动）
        已锁定/已确认后 cancel 或 release：同一命令内原子回补配额
```

- `ordinary`：普通安排，受产线日配额限制。
- `urgent-authorized`：紧急突破，必须提供理由码，且授权人持有效、覆盖该理由的授权。
- 授权与理由的有效期在**授权时**和**占用（锁定）前**各验证一次；任何过期、越权、关联错误都在落盘前拒绝，不产生事件、不改变产线可用量。
- 每个预警最多对应一个窗口承诺（编号 `C-<alertId>`），重复锁定一律拒绝。

## 一致性保证

- **命令幂等**：每条命令携带 `commandId`。相同命令并发到达共享同一个在途结果（响应带 `deduplicated:true`）；消息重投在耐久记录中识别后返回首次结果（`replayed:true`）。同一 `commandId` 关联到不同预警/动作返回 `409 COMMAND_CONFLICT`。
- **原子衔接**：授权、锁定、撤销、释放在单进程串行临界区中完成「校验 → 落盘 → 生效」，校验失败绝不写入。
- **事件溯源**：所有状态变化只追加到哈希链日志（`EVENT_LOG`，默认 `./data/events.log`），每行 `{seq,type,payload,hash}`，`hash = sha256(prevHash | type | payload)`。重启时重放算出实际配额、授权人和承诺；日志被篡改会在断链处停止重放。
- **写入中断恢复**：日志尾部的半截记录（崩溃现场）在加载时自动截断，已完整落盘的事件全部保留，新事件从正确序号续链。

## 接口

登记类（同键同值幂等，键冲突返回 409）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/lines` | `{lineId, capacity}` 登记产线日配额 |
| POST | `/admin/reasons` | `{reasonCode, validUntil}` 登记理由及有效期 |
| POST | `/admin/grants` | `{grantId?, subject, level, reasonCode?, expiresAt}` 登记授权 |
| POST | `/alerts` | `{alertId, lineId, level, demand?}` 登记预警 |

决策命令（均需 `{commandId, alertId, by}`，紧急授权还需 `reasonCode`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/commands/authorize` | 授权（占用前校验权限与有效期） |
| POST | `/commands/hold` | 锁定检查窗口，扣减配额，生成唯一承诺 |
| POST | `/commands/approve` | 窗口内确认检查结论 |
| POST | `/commands/cancel` | 撤销；已占用则在同一事件中回补 |
| POST | `/commands/release` | 释放窗口并回补配额（终态） |

核对接口（值班主管按预警编号核对唯一承诺、授权人与容量变化）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/alerts/:alertId` | 预警全貌：授权快照、承诺、容量变化流水 |
| GET | `/commitments/:commitmentId` | 承诺：预警、授权人、理由、扣减前后容量 |
| GET | `/lines/:lineId` | 产线总配额与当前可用量 |
| GET | `/health` | 运行状态与已落盘事件数 |

错误响应统一为 `{error, message}`，常见码：`GRANT_MISSING`(403)、`EXPIRED`(403)、`SUBJECT_MISMATCH`(403)、`REASON_REQUIRED`/`REASON_UNKNOWN`(4xx)、`INVALID_STATE`(409)、`QUOTA_EXHAUSTED`(409)、`COMMAND_CONFLICT`(409)。

## 本地运行

```bash
npm test
EVENT_LOG=./data/events.log PORT=8080 npm start
```
