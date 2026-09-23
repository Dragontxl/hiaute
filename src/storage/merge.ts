/**
 * 幂等检查点的合并语义（§10 风险 7）。
 *
 * 回调/流水线可能重放同一阶段，因此合并必须满足：
 *  - remoteTasks：同 key 后者覆盖（同一 shot 的重试应指向最新远程任务）；
 *  - completedStages / completedShots：并集去重（重复上报不会重复计数）。
 * 纯函数，供 memory 与 D1 两套仓储共用，避免两处各写一份。
 */
import { STAGE_ORDER } from '../types/index.js';
import type { Stage, TaskCheckpoint } from '../types/index.js';

export function emptyCheckpoint(): TaskCheckpoint {
  return { remoteTasks: {}, completedStages: [], completedShots: [] };
}

/**
 * 合并两个检查点；patch 允许只给部分字段（例如阶段推进只带 completedStages）。
 */
export function mergeCheckpoints(base: TaskCheckpoint | undefined, patch: Partial<TaskCheckpoint>): TaskCheckpoint {
  const b = base ?? emptyCheckpoint();
  const remoteTasks: Record<string, string> = { ...b.remoteTasks };
  for (const [k, v] of Object.entries(patch.remoteTasks ?? {})) remoteTasks[k] = v;
  return {
    remoteTasks,
    completedStages: [...new Set([...b.completedStages, ...(patch.completedStages ?? [])])],
    completedShots: [...new Set([...b.completedShots, ...(patch.completedShots ?? [])])],
  };
}

/**
 * 防御式解析检查点（来自磁盘文件或 GHA 回调 body）：
 * 未知字段丢弃、类型不符的条目过滤，保证上层拿到的永远是合法 TaskCheckpoint。
 */
export function parseCheckpoint(raw: unknown): TaskCheckpoint {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const remoteTasks: Record<string, string> = {};
  if (typeof o.remoteTasks === 'object' && o.remoteTasks !== null) {
    for (const [k, v] of Object.entries(o.remoteTasks as Record<string, unknown>)) {
      if (typeof v === 'string') remoteTasks[k] = v;
    }
  }
  const stages = Array.isArray(o.completedStages)
    ? o.completedStages.filter((s): s is Stage => typeof s === 'string' && (STAGE_ORDER as string[]).includes(s))
    : [];
  const shots = Array.isArray(o.completedShots)
    ? o.completedShots.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    : [];
  return { remoteTasks, completedStages: stages, completedShots: shots };
}
