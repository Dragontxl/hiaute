/**
 * 领域类型定义（依 V2 方案 §2 四层架构 / §7.5 账户池 / §7.1 任务流水线）
 *
 * 约定：
 * - 应用层永不直接调用模型；全部经 hypit.runtime.json 的 endpoints + bindings 绑定。
 * - Provider 真实能力以 `supports` 如实上报；能力不足时带原因拒绝，绝不偷偷改共享 Model。
 */

/** 能力类型：同一 api_type 下可挂多个账户（Gemini=2、Agnes=5）。 */
export type ApiType = 'gemini' | 'agnes-text' | 'agnes-image' | 'agnes-video' | 'edgetts';

/** 账户运行期状态（对应 §7.5 的 ai_accounts 字段）。 */
export interface AccountState {
  id: string;
  alias: string;
  apiType: ApiType;
  /** 加密后的密钥；运行期解密注入，严禁明文落日志。 */
  apiKeyEncrypted: string;
  baseUrl: string;
  modelName?: string;
  /** 并发上限。 */
  maxConcurrent: number;
  /** 加权随机权重（主 100 / 备 50）。 */
  priorityWeight: number;
  /** 单次调用后的租约冷却秒数。 */
  cooldownSeconds: number;
  /** 每日调用上限（对齐服务真实免费额度）。 */
  dailyLimit: number;
  isActive: boolean;
  isHealthy: boolean;
  healthCheckMsg?: string;
  lastHealthCheck?: number;
  totalUsage: number;
  /** 冷却截止时间戳（ms）；null 表示可用。 */
  cooldownUntil: number | null;
}

/** 一次账户调用的租约（use-then-release）。 */
export interface AccountLease {
  account: AccountState;
  /** 明文密钥（仅存在于内存与本次请求上下文）。 */
  apiKey: string;
  release: () => Promise<void>;
}

/** Provider 如实上报的能力声明（用于 plan 阶段校验）。 */
export interface ProviderCapabilities {
  apiType: ApiType;
  models: string[];
  /** 视频输出档位。 */
  resolutions?: Array<'480p' | '720p' | '1080p'>;
  /** 单条时长上限（秒）——默认取官方保守值。 */
  maxSecondsPerShot?: number;
  maxFrames?: number;
  fps?: number;
  /** 是否支持原生音画同轨。 */
  nativeAudio?: boolean;
  /** 结构化输出是否受支持。 */
  structuredOutput?: boolean;
}

/** 任务状态机（对应 §7.1 控制面）。 */
export type TaskStatus =
  | 'PENDING'
  | 'DISPATCHED'
  | 'RUNNING'
  | 'PAUSED' // 全账户不可用时的待恢复态（§7.5）
  | 'COMPLETED'
  | 'FAILED';

/** 6 阶段流水线（对应 §7.1）。 */
export type Stage =
  | 'DETECT'
  | 'ANALYZE'
  | 'CROP_SHOTS'
  | 'CONVERT_FRAMES'
  | 'GENERATE_SHOTS'
  | 'COMPOSE';

export const STAGE_ORDER: Stage[] = [
  'DETECT',
  'ANALYZE',
  'CROP_SHOTS',
  'CONVERT_FRAMES',
  'GENERATE_SHOTS',
  'COMPOSE',
];

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  stage: Stage;
  /** 参考视频地址（对象存储/URL）。 */
  referenceUrl?: string;
  /** 单任务时长上限（秒）——降档策略的关键参数（§8.4）。 */
  maxDurationSeconds: number;
  /** 抽帧归一化边长（默认 512，§8.4）。 */
  normalizeSize: number;
  /** Agnes 输出档位（默认 480p/720p）。 */
  outputResolution: '480p' | '720p' | '1080p';
  /** Studio 编辑用的 Run Source（可选；启动编辑会话时写入，如 runs/main.svrun）。 */
  runFile?: string;
  createdAt: number;
  updatedAt: number;
  checkpoint?: TaskCheckpoint;
  error?: string;
}

/** 幂等恢复用的进度检查点（§10 风险 7）。 */
export interface TaskCheckpoint {
  /** 远程任务 id 映射，如 Agnes video task_id -> shot 索引。 */
  remoteTasks: Record<string, string>;
  completedStages: Stage[];
  /** 已完成的分镜索引。 */
  completedShots: number[];
}

/** 参考视频分析产物（对应 hypit ANALYSIS.md / TIMELINE.md，§4）。 */
export interface VideoAnalysis {
  summary: string;
  shots: Array<{
    index: number;
    startSec: number;
    endSec: number;
    description: string;
    onScreenText?: string;
    effects?: string[];
  }>;
  speakers?: Array<{ id: string; role?: string }>;
}

/** 应用配置（从环境变量与 hypit.runtime.json 装载）。 */
export interface AppConfig {
  /** 本地内核 CLI 名（默认 hypit）。 */
  hypitCli: string;
  /** 单任务时长上限（秒），默认 180（§8.4）。 */
  maxDurationSeconds: number;
  /** 抽帧归一化边长，默认 512（§8.4）。 */
  normalizeSize: number;
  /** Agnes 输出档，默认 720p。 */
  outputResolution: '480p' | '720p' | '1080p';
  /** 控制面鉴权令牌（Authorization: Bearer <token>）；未设置时 /api/v1 不鉴权（仅本地开发）。 */
  apiToken?: string;
  /** 分镜条数上限（成本控制），默认 10。 */
  maxShots: number;
  dataDir: string;
  /** 账户库主密钥（用于对称加密 API Key）。 */
  masterKey: string;
  /** 回调签名密钥（§7.3）。 */
  callbackSecret: string;
  /**
   * 存储驱动（推荐方案）。
   * - 'memory'     ：本地 / 常驻形态（含 Hypit Studio）
   * - 'cloudflare' ：Workers 形态（Durable Objects + D1 + R2，不用 KV）
   */
  storageDriver: 'memory' | 'cloudflare';
  /** GHA 分发配置。 */
  github?: {
    pat: string;
    owner: string;
    repo: string;
    eventType: string;
    callbackUrl: string;
  };
}
