import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInitialState, applyEvent, GENESIS_HASH } from './domain.js';

export function computeHash(prevHash, type, payload) {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(type)
    .update('\n')
    .update(JSON.stringify(payload))
    .end()
    .digest('hex');
}

// 追加式事件日志。每行一个 JSON 对象：
//   {seq,type,payload,hash}  hash = sha256(prevHash | type | JSON.stringify(payload))
// 哈希链让任何篡改/断链在重放时立刻暴露；尾部写坏（写入中断）属于崩溃现场，
// 截断到最后一条完整记录后继续，保证状态完全由耐久记录决定。
export class EventStore {
  constructor(file) {
    this.file = file;
    this.fh = null;
    this.state = createInitialState();
    this.truncated = 0;
  }

  async load() {
    let raw = '';
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const lines = raw.split('\n');
    const good = [];
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;

    for (const line of lines) {
      if (line === '') continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        break; // 半截写：到此为止，后面整段丢弃
      }
      if (
        typeof evt.seq !== 'number' ||
        typeof evt.type !== 'string' ||
        evt.payload === undefined ||
        typeof evt.hash !== 'string' ||
        evt.seq !== expectedSeq ||
        computeHash(prevHash, evt.type, evt.payload) !== evt.hash
      ) {
        break; // 断链/错序/哈希不符：视为日志终点
      }
      good.push(evt);
      prevHash = evt.hash;
      expectedSeq += 1;
    }

    const dropped = lines.filter((l) => l !== '').length - good.length;
    if (dropped > 0) {
      await fs.writeFile(this.file, good.map((e) => JSON.stringify(e)).join(good.length ? '\n' : '') + (good.length ? '\n' : ''));
      this.truncated = dropped;
    }

    for (const evt of good) applyEvent(this.state, evt);

    this.fh = await fs.open(this.file, 'a');
    return this.state;
  }

  // 先构造再 append：一旦落盘失败，内存状态绝不推进。
  buildEvent(type, payload) {
    const seq = this.state.seq + 1;
    const hash = computeHash(this.state.lastHash, type, payload);
    return { seq, type, payload, hash };
  }

  async append(events) {
    const chunk = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    // 写后强制刷盘（数据 + 元数据），随后再在内存生效。
    await this.fh.writeFile(chunk);
    try {
      await this.fh.sync();
    } catch {
      // 某些文件系统不支持 fsync；写入本身已成功。
    }
    for (const evt of events) applyEvent(this.state, evt);
  }

  async close() {
    if (this.fh) {
      await this.fh.sync().catch(() => {});
      await this.fh.close();
      this.fh = null;
    }
  }

  // 仅供测试：另起一个实例从日志重放，验证可恢复性。
  async replay() {
    const fresh = new EventStore(this.file);
    await fresh.load();
    return fresh.state;
  }
}