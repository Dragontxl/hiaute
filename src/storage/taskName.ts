/**
 * 任务命名 / 产物目录工具（缺省名 = 创建时间）。
 *
 * - `formatTaskName`：用户未指定名称时的默认任务名（本地时间 YYYYMMDD-HHmm）。
 * - `formatTaskStamp`：产物目录唯一后缀（UTC YYYYMMDDHHmm，跨环境确定，前后端一致）。
 * - `artifactDirName`：R2 产物目录名 = `<名称>_<UTC时间戳>`，保证唯一。
 *
 * 前端以相同的 JS 表达式计算（见 frontend/index.html），因此“浏览产物”能定位到同一目录。
 */

/** 缺省任务名：以创建时间命名（YYYYMMDD-HHmm）。 */
export function formatTaskName(now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 产物目录唯一后缀（UTC，YYYYMMDDHHmm，12 位）。 */
export function formatTaskStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

/**
 * R2 产物目录名 = `<名称>_<UTC时间戳>`。
 * 名称中的 `/`、`\` 替换为 `_`；名称缺失时用任务 ID。
 */
export function artifactDirName(name: string | undefined, id: string, createdAt: number): string {
  const base = (name && name.trim() ? name.trim() : id).replace(/[\\/]/g, '_');
  return `${base}_${formatTaskStamp(createdAt)}`;
}