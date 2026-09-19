// 追加写事件存储：所有决策只追加不可变事件，每次写入 fsync 后才更新内存投影。
// 启动时重放日志重建配额；若最后一次写入在 fsync 前中断（末尾出现半行），
// 截断残缺字节后重放，保证算回的配额与已耐久的记录完全一致。

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createProjection, applyEvent, DomainError } from './domain.js';

export async function createEventStore({ file, clock = () => Date.now(), logger = console } = {}) {
  if (!file) throw new Error('createEventStore 需要 file 参数');
  await fs.mkdir(dirname(file), { recursive: true });

  let state = createProjection();
  await recover();

  const handle = await fs.open(file, 'a');
  // 所有 append/事务串行化：授权→锁定→撤销/释放的临界区在本进程内不会交错。
  let chain = Promise.resolve();

  async function recover() {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!raw) return;

    const lines = raw.split('\n');
    let cleanBytes = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastSegment = i === lines.length - 1;
      // 文件以换行结尾时 split 产生的最后一个空段：日志完整，无需处理。
      if (isLastSegment && line === '') break;
      if (!line.trim()) {
        cleanBytes += Buffer.byteLength(line) + 1;
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // 只有“文件末尾且没有换行符”的最后一行允许是写入中断的残行。
        const isTornTail = isLastSegment && !raw.endsWith('\n');
        if (!isTornTail) throw new DomainError('corrupt-log', `事件日志第 ${i + 1} 行无法解析`);
        await fs.truncate(file, cleanBytes);
        logger.warn?.(`检测到未耐久完成的残行，已截断 ${Buffer.byteLength(line)} 字节后重放`);
        return;
      }
      applyEvent(state, event);
      cleanBytes += Buffer.byteLength(line) + 1;
    }
  }

  async function durableAppend(baseEvent, at) {
    const event = { seq: state.seq + 1, at, ...baseEvent };
    const chunk = JSON.stringify(event) + '\n';
    await handle.write(chunk);
    await handle.sync(); // 先落盘，再让调用方更新内存
    applyEvent(state, event);
    return event;
  }

  // fn(state, now) 必须同步完成“校验 + 构造事件”，返回：
  //   { event, build? }  追加事件，build(state) 在事件应用后生成返回视图
  //   { result }         不产生事件（幂等重放）
  function transact(fn) {
    const run = chain.then(async () => {
      const now = clock();
      const planned = fn(state, now);
      if (!planned || !planned.event) return planned?.result ?? null;
      const event = await durableAppend(planned.event, now);
      return planned.build ? planned.build(state, event) : { seq: event.seq };
    });
    // 失败不能中断后续事务的串行链。
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function close() {
    await chain;
    await handle.close();
  }

  return {
    transact,
    close,
    get state() {
      return state;
    },
  };
}
