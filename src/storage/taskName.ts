/**
 * 任务命名工具（缺省名 = 创建时间）。
 *
 * 用户未指定任务名时，以创建时间命名（YYYYMMDD-HHmm），便于在列表中区分任务。
 * D1 与内存两套仓储共用，保证两种驱动下命名规则一致。
 */

/** 缺省任务名：以创建时间命名（YYYYMMDD-HHmm）。 */
export function formatTaskName(now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
