# Hypitapp

> 基于 [hypit](https://github.com/) 的「视频复刻」应用化改造骨架。
> 实现依据：`Hypit 应用改造方案-V2.md`（四层架构 + GitHub Actions 算力 + 多账户池 + 降档策略 + 磁盘监控）。

## 它是什么

Hypitapp 把 hypit 的「参考视频 → 复刻生成视频」能力封装成一个可自托管的服务：

```
前端(静态页) → 控制面 API(Hono) → 分发器 → GitHub Actions(6 阶段流水线) → 产物对象存储
                        ↑                                                     │
                        └──────────────── 带签名回调 ────────────────────────┘
```

- **控制面**（`src/server`）：接收任务、持久化、向 GitHub 发 `repository_dispatch`、提供状态查询。
- **执行面**（`.github/workflows/hypit-task.yml` + `docker/`）：在 Actions 免费算力上运行 6 阶段流水线。
- **Provider 层**（`src/providers`）：Agnes（文本/图像/视频）、Gemini（视频理解）、EdgeTTS（配音），统一契约 + 多账户池。
- **内核**（`src/kernel`）：对 `hypit` CLI 的封装，负责 Script(.svml) 渲染。

## 目录结构

```
Hypitapp/
├── src/
│   ├── config/accounts.ts     # 账户配置装载（从 hypit.runtime.json 读取，密钥来自 HYPIT_<ALIAS>_KEY）
│   ├── core/                  # crypto / logger / accountPool / retry
│   ├── providers/             # types + agnes + gemini + edgetts + registry
│   ├── planner/               # LLM 规划器（参考视频 → 分镜脚本 / SVML）
│   ├── kernel/                # hypit CLI 封装 + Studio 常驻会话
│   ├── pipeline/              # 6 阶段流水线（含磁盘快照与降级）
│   ├── server/                # 控制面：dispatch / routes / index（Hono）
│   ├── storage/               # 统一存储抽象：memory / fs / cloudflare(DO+D1+R2) + 限流规则 + 检查点合并
│   ├── types/                 # 领域类型
│   ├── worker.ts              # Cloudflare Workers 入口
│   └── index.ts               # 入口（task / serve 子命令）
├── docker/
│   ├── Dockerfile             # Actions 执行镜像
│   └── scripts/               # monitor-disk.sh / run-pipeline.sh
├── .github/workflows/         # ci.yml（typecheck+test）/ hypit-task.yml（渲染任务）
├── frontend/index.html        # 静态控制台
├── docs/DEPLOY.md             # 部署说明
├── test/                      # 单元测试（node:test + tsx）
├── tsconfig.json / tsconfig.test.json
├── hypit.runtime.example.json # Provider 绑定 + 账户池示例
└── .env.example               # 环境变量示例
```

## 快速开始

```bash
cp .env.example .env                 # 填入密钥（切勿提交）
cp hypit.runtime.example.json hypit.runtime.json
npm install

# 门禁：类型检查（含测试）+ 单元测试
npm run typecheck
npm test

# 本地跑一次任务（不走 Actions；TASK_ID 决定检查点文件，重跑同 ID 会从断点续跑）
TASK_ID=demo1 TASK_REFERENCE_URL=https://.../ref.mp4 npx tsx src/index.ts task

# 启动控制面
HYPITAPP_API_TOKEN=xxx npx tsx src/index.ts serve
```

控制面鉴权：设置 `HYPITAPP_API_TOKEN` 后，除 `/api/v1/callback/*`（走 HMAC 签名）外的
所有 `/api/v1` 端点都需要 `Authorization: Bearer <token>`。

依赖工具：`ffmpeg` / `ffprobe` 用于裁切、抽帧与合成（§8.4）。缺失时相应阶段**降级跳过并告警**，
流水线仍会产出 SVML 与分镜脚本；`hypit` CLI 缺失时跳过 SVML 编译校验。

产物与检查点落在 `HYPITAPP_DATA_DIR`（默认 `./data`）：

```
data/tasks/<taskId>/{reference.mp4, script.svml, shots/, frames/, outputs/}
data/checkpoints/<taskId>.json        # 幂等检查点，重跑同 ID 自动续跑
data/objects/tasks/<taskId>/final.mp4 # 产物对象存储（FsObjectStore）
```

详见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 关键设计

### 多账户池与故障切换（V2 §7.5）
- `priority_weight` 加权选取；`cooldown_until` 租约锁避免并发撞同一账户；连续失败 ≥3 次标记 `is_healthy=false`。
- **全部不可用**时：挂起等待 + 指数退避（5s→15s→45s…）+ 到点后重新选池，**不是**固定顺序从头再走一遍。
- 「谁被占用 / 冷却 / 隔离」的强一致状态统一落在**租约存储后端**（memory 驱动为进程内，cloudflare 驱动为 Durable Object），
  `AccountPool` 只负责账户配置、每日配额、并发上限与密钥解密——两套驱动共用同一条代码路径。
- 限流规则集中在 `src/storage/rules.ts`，计数由 `RateLimitBackend` 原子判定；授予租约后才扣额度，未选中不浪费配额。

### 降档策略（V2 §8.4）
- 时长上限 `MAX_DURATION_SECONDS=180`（主杠杆）；DETECT 阶段用 ffprobe 实测拦截
- 分镜条数上限 `MAX_SHOTS=10`（成本控制）
- 抽帧归一化 `NORMALIZE_SIZE=512`（1024²→512²）
- Agnes 输出 `OUTPUT_RESOLUTION=720p`

### 幂等检查点（V2 §10 风险 7）
- 每阶段完成 / 每个分镜完成后即写 `<dataDir>/checkpoints/<taskId>.json`
- 重放同一阶段不会重复计数（`mergeCheckpoints` 并集去重 + 同 key 覆盖）
- D1 侧状态流转用 `UPDATE ... WHERE status NOT IN ('COMPLETED','FAILED')`，终态不可被覆盖

### 控制面鉴权
- `HYPITAPP_API_TOKEN`：Bearer 令牌，常量时间比较；未设置时仅本地开发放行并告警
- `/api/v1/callback/github` 例外，走 HMAC 签名 `X-Callback-Signature`
- 所有 JSON body 经 zod 校验；`runFile` 强制相对路径 + 白名单扩展名，拒绝目录穿越

### 存储驱动（推荐方案：DO + D1 + R2，不用 KV）
- 统一抽象 `src/storage/`，`STORAGE_DRIVER` 切换：
  - `memory`：本地/常驻形态（含 Studio）；产物落盘到 `HYPITAPP_DATA_DIR/objects`（FsObjectStore），
    也可退回内存占位实现（返回 `memory://` URL，仅供调试）。
  - `cloudflare`：Workers 形态 —— **Durable Objects**（限流计数 + 账户租约，强一致）+
    **D1**（任务/状态机）+ **R2**（产物）。
- **不用 KV**：KV 最终一致，做不了原子计数与并发锁；强一致需求落在 Durable Objects。
- 部署配置见 `wrangler.toml.example`；建表见 `src/storage/cloudflare/schema.sql`。

### 磁盘监控（V2 §8.5）
- 阶段边界打印 `df -h` / `du -sm`
- 后台守护 `monitor-disk.sh` 定时写 CSV，`tee` 进日志
- workflow `if: always()` 归档 CSV 到 artifact + 写入 Step Summary

## 合规提醒

- hypit 使用**修改版 Apache 2.0**：禁止多租户 SaaS、禁止商业再分发、不得移除 LOGO。本骨架面向**自用/单租户**场景。
- Agnes/Gemini/EdgeTTS 均受各自 ToS 约束；多账户池**不得**用于规避配额或滥用免费额度。
- Gemini 免费层输入可能被用于改善模型，涉密素材请勿上传。

## 状态

主链路已贯通：DETECT（下载 + ffprobe 时长拦截）→ ANALYZE（Gemini 上传 + 视频理解）→ CROP_SHOTS
→ CONVERT_FRAMES（归一化抽帧）→ GENERATE_SHOTS（写 SVML + 编译校验 + 逐镜生成）→ COMPOSE（合成 + 上传）。
核心逻辑有单元测试覆盖（`npm test`，44 个用例）。

仍为占位 / 需按实际环境补齐的部分：
- Agnes / Gemini 的端点路径与字段名按各自真实 API 调整（`src/providers/`）。
- 本地检测（WhisperX / YOLO）未接入，说话人识别依赖 Gemini 的推断。
- `hypit.runtime.json` 的 `use` 字段仅作标识，尚未做动态 Provider 装载。
- 前端 `frontend/index.html` 为最小静态页，需按你的 API token 配置调用。
