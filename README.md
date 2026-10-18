# dsh-ssh-explorer

> VSCode 式的 **SSH 远程资源管理器**，作为 [DSH](https://github.com/deepseek-ai) 桌面版（Web GUI）的侧栏插件运行：
> 侧栏一个面板就能浏览远端文件、双击预览、就地编辑保存、**双向拖拽传文件**、右键新建/改名/删除，
> 再挂一个远端终端和 AI 对话。

**插件名**：`dsh-ssh-explorer`　**版本**：`1.7.0`　**许可证**：MIT　**零第三方依赖**

```
侧栏「SSH 远程资源管理器」 → 选连接 → 浏览远端目录 → 拖出去 = 下载 / 拖进来 = 上传
```

---

## 目录

- [特性](#特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速上手](#快速上手)
- [使用手册](#使用手册)
- [它是怎么实现的](#它是怎么实现的)
- [HTTP API](#http-api)
- [配置文件与状态目录](#配置文件与状态目录)
- [跑测试](#跑测试)
- [已知限制](#已知限制)
- [排错](#排错)
- [目录结构](#目录结构)
- [更新日志与许可](#更新日志与许可)

---

## 特性

| 分类 | 能力 |
|---|---|
| **连接** | 自动读取 Windows 的 `~/.ssh/config`（含 `HostName` / `User` / `Port` / `IdentityFile`）并导入；也能在面板里新建连接；`auto` / `key` / `password` / `agent` 四种认证方式 |
| **口令** | 每台主机一条独立口令，用 **Windows DPAPI（CurrentUser 作用域）** 加密存在本机，只有你这台机器这个账户能解开 |
| **浏览** | 远端目录树、面包屑、`↑` 上级、`⌂` 家目录、点文件即在右侧预览、目录与文件大小和 mtime 一起显示 |
| **预览 / 编辑** | 文本直接预览（上限 512 KB），点「编辑」就地改，`Ctrl+S` 存回远端：**先写临时文件再原子替换**，覆盖前自动留 `.re-bak`，`0o777` 权限位保住 |
| **传文件** | **双向拖拽**：远端文件/文件夹拖出窗口 = 下载到桌面（落的是**真实文件夹**，不是压缩包）；从资源管理器拖进来 = 上传到当前目录或某个目录行；批量拖动多选项 = 批量传输；右下角有进度抽屉，可取消 |
| **选中 / 删除** | 单击选中、`Ctrl`+单击多选、`Delete` 键或右键菜单删除（**二次确认**，拒绝删 `/` 和家目录） |
| **新建 / 改名** | 列表空白处右键新建文件或文件夹；选中一条右键重命名（内容、权限、mtime 都跟着走） |
| **终端** | 底部远端终端（`POST /exec`），高度可拖，退出码与 cwd 真实回传 |
| **AI 对话** | 右侧可拉伸停靠栏，**流式**（SSE）输出思考过程 / 工具调用 / 正文，支持 markdown；模型下拉按你配置的提供商分组；AI 可以借远端终端真跑命令 |

> 截图请自行放进 `docs/images/` 并在下面补图（本仓库没有预置截图）。
>
> ```markdown
> ![浏览与预览](docs/images/main.png)
> ![拖拽传文件](docs/images/transfer.png)
> ```

---

## 环境要求

| 角色 | 要求 |
|---|---|
| 本机 | Windows 10 / 11 + DSH 桌面版；`ssh.exe`（Windows 自带 `C:\Windows\System32\OpenSSH\ssh.exe` 即可，也认 PATH 里的） |
| 远端 | `python3`（Ubuntu 20.04+/Debian 11+ 自带）；传文件夹额外需要 **GNU tar 1.29+** |
| 开发 | Node.js 18+（跑测试用；DSH 自带运行时也行） |

插件本体**零第三方依赖**：宿主半边只用 Node 内建模块，客户端半边只用 `react`（由 DSH 注入）。

---

## 安装

### 方式 A：一键脚本（推荐）

```powershell
# 解压后进入目录
$env:PYTHONIOENCODING = "utf-8"   # Windows 控制台是 GBK，中文输出可能花屏
python install.py                 # 安装（幂等）
python install.py --verify        # 只读校验，不改任何东西
python install.py --rollback      # 卸载（删补丁块 + 删部署目录，改动前先备份）
```

脚本做两件事：把 `plugin\` 复制到 `%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-ssh-explorer\`，
再往 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里追加一段装载块：

```yaml
# [ssh-explorer] begin
# SSH 远程资源管理器：宿主路由 /x-ssh-explorer/* + 侧栏面板 ssh-explorer。
- insert:
    - id: ssh-explorer
      name: './plugins/dsh-ssh-explorer/lib/index.js'
      config:
        rev: 11
# [ssh-explorer] end
```

> `rev` 是**客户端 bundle 的缓存破坏号**：只要改了 `plugin/lib/client.js` 就必须 +1，
> 否则浏览器可能继续用旧前端。它和 `package.json` 的 `version` 无关，但要一起往前走。

### 方式 B：手动

1. 把 `plugin\` 整个目录拷到 `%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-ssh-explorer\`
2. 在上面那个 `cordis.patch.yml` 里加上面那段装载块（`rev` 用当前值）
3. **完全退出 DSH** 再打开

> ⚠️ **改完必须完全退出 DSH 再开**：宿主半边（路由）只在启动时加载一次。
> 只改客户端半边（`client.js`）时，刷新页面即可生效。
> ⚠️ 别用记事本另存 YAML/JSON——它可能加 BOM，解析会失败；用 VSCode / Notepad++ 存 UTF-8 无 BOM。

装好后侧栏活动栏会出现 **SSH 远程资源管理器** 图标。

---

## 快速上手

1. 点侧栏图标打开面板，左上角下拉里选一台主机（来自 `~/.ssh/config`，或点「＋ 新建连接」自己填）
2. 第一次连某台机器要输口令，填完勾上记住即用 DPAPI 加密存本机
3. 浏览器览远端目录：点目录进去、点面包屑回退、`↑` 上级、`⌂` 家目录
4. **要下载**：把文件/文件夹从列表里**拖出窗口**松手（落点是桌面），行尾也有 `⬇`
5. **要上传**：从资源管理器把文件/文件夹**拖进列表**（空白处 = 当前目录，拖到某目录行 = 那个目录）
6. 右下角 `⇅ 传输` 抽屉里看进度，传输中可取消，完成后可「在资源管理器中显示」

---

## 使用手册

完整版（含每个端点、每个边界情况、28 条踩坑记录）见 **[docs/使用说明.md](docs/使用说明.md)**。下面是速查。

### 连接

| 操作 | 说明 |
|---|---|
| 选连接 | 顶部下拉；`~/.ssh/config` 里的主机会自动带上（标「来自 ~/.ssh/config」） |
| ＋ 新建连接 | 自己填名称 / 主机 / 端口 / 用户名 / 私钥路径 / 认证方式 |
| 🔑 设密码 / 改密码 | 给这一台单独存一条口令（DPAPI 加密） |
| 🗑 管理连接 | 浮层里删设备：自建连接**真删**（口令一起删），`~/.ssh/config` 里的只**隐藏**（配置文件不动），进了「已删除」分组还能一键恢复 |

### 浏览与预览

| 操作 | 结果 |
|---|---|
| 单击一行 | 选中；文件顺带在右侧预览 |
| 双击目录 | 进入该目录 |
| 双击文件 | 重开预览 |
| 面包屑 / `↑` / `⌂` | 跳转 / 上级 / 家目录 |
| 拖中间那条分隔条 | 调整列表与预览的宽度（记在 localStorage） |
| 预览页「编辑」 | 进入编辑态，`Ctrl+S` 存回远端（先写 `.re-tmp` 再原子替换，原文件留 `.re-bak`） |

### 传文件（拖拽）

| 方向 | 做法 | 落地 |
|---|---|---|
| 远端 → 本机 | 把行（或多选的一批）**拖出窗口**松手；或点行尾 `⬇`；或右键「⬇ 下载到桌面」 | 真实文件 / 真实文件夹写到**桌面**（可配置），中文名与 mtime 原样保留 |
| 本机 → 远端 | 从资源管理器把文件/文件夹拖进列表空白处（=当前目录）或某个目录行 | 传到对应远端目录；同名默认**不覆盖** |

- 多选后拖动 = **批量传输**，每一条在抽屉里各占一行，独立显示成功/失败。
- 传输跑在宿主侧（不是浏览器下载），所以被壳的下载限制影响不到；进度按字节实时更新，可随时取消（取消不留半成品）。

### 选中 / 删除 / 新建 / 改名

| 操作 | 结果 |
|---|---|
| `Ctrl`（macOS 上 `⌘`）+ 单击 | 加选 / 取消这一条；选多条时浏览区左下角浮出「已选 N 项」浮条 |
| `Delete` | 删选中的一批（先弹确认框） |
| 右键选中项 | 菜单：`⬇ 下载到桌面` / `🗑 删除` / `取消选择`（多选时作用于整批） |
| 右键选中**一条** | 多一项 `✏️ 重命名…`（预填旧名并全选，`Enter` 提交、`Esc` 取消） |
| 右键**空白处** | `📄 新建文件…` / `📁 新建文件夹…`（建在当前目录，建完自动选中） |

安全阀：拒绝删 `/` 与家目录本身、拒绝在 `/` 下新建、拒绝把 `/` 或家目录改名；重名回 409 并把原因显示在浮层里。

### 远端终端 / AI 对话

- **终端**：工具栏「⌨ 终端」开关底部终端，高度可拖，`↑`/`↓` 翻历史，退出码与 cwd 真实回传。
- **AI 对话**：工具栏「✦ AI 对话」打开右侧停靠栏，可拖宽；**流式**输出，思考过程可折叠，工具调用是卡片；模型下拉按提供商分组，`/chat-models` 拉清单。
  - 默认复用 DSH 自己的模型配置（`~/.dsh/.credentials.yaml` 里的 key）；想换模型或换网关就写 `~/.dsh/ssh-explorer/chat.json`。

---

## 它是怎么实现的

两半 + 一条同源 HTTP 通道：

```
┌──────────────────────────── DSH 桌面版（Electron） ────────────────────────────┐
│  renderer（浏览器侧）                        host（Node 子进程 / Cordis 插件）  │
│  ┌──────────────────────────┐   fetch()   ┌──────────────────────────────────┐ │
│  │ client.js                │ ──────────► │ index.js                          │ │
│  │  侧栏面板 / 拖拽 / 键盘   │ ◄────────── │  /x-ssh-explorer/* 19 条路由      │ │
│  └──────────────────────────┘   JSON/SSE  │    ├─ ssh.exe（execFile / spawn） │ │
│                                            │    ├─ tar 读/写（纯 JS 实现）     │ │
│                                            │    └─ 任务队列（进度/取消）       │ │
│                                            └──────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
                             │ ssh
                             ▼
                    远端 Linux（python3 + GNU tar）
```

几个刻意的选择，都有实测依据：

1. **零 `@deepseek-ai/*` 依赖**：本地 `plugins/` 挂载的插件不会被 pnpm 装依赖，所以宿主半边只 `import` Node 内建模块，能力全部从 Cordis 的 `ctx` 拿（`ctx.get("webServer").register(...)`、`ctx.effect(...)`）。
2. **远端命令一律走 `python3`**：把脚本 base64 后交给远端 `python3` 执行、结果回 JSON，绕开 Windows → SSH → 远端 shell 三层引号问题，还天然可结构化。
3. **`tar` 只当传输管，不用 Windows 的 `tar.exe`**：Windows 自带的 `tar.exe` 是精简版 bsdtar，既不支持 `--hdrcharset=UTF-8`，解 UTF-8 中文名还会按 GBK 误解成乱码（`中文 目录` → `涓枃 鐩綍`）。所以远端出 `tar -cf -`、本机用**自己写的 tar 读/写器**落地，中文名与 mtime 原样保留。往远端推目录同理。
4. **拖出窗口 = 宿主侧后台拷贝，不是系统级拖放**：Electron 壳里 `will-download` 被 `preventDefault()`（浏览器下载全灭），`startDrag` 也没暴露给页面，所以页面上能"拖出去"的最多是一次浏览器下载。于是做成「发现你把行拖出了窗口 → 在宿主侧替你拷贝到桌面 → `explorer /select` 定位」。**好处**是能落成真实文件夹、能保留 mtime、能显示进度；**代价**是不能把文件丢进别的应用窗口。
5. **长任务不占请求**：传输/删除走「起任务 + 轮询快照」，请求立刻返回 `{ok, job}`，前端 700ms 拉一次 `/job?id=`。

安全模型：

- 所有路由都过**同源栅栏**（`sec-fetch-site: cross-site` 直接拒；带 `Origin` 的必须与 `Host` 同 authority），避免被任意网页调用。
- 口令不落明文：`SSH_ASKPASS` + DPAPI 加密文件，进程内只在需要时解密给 `ssh.exe`。
- 破坏性操作（删、改名、新建、覆盖）都在宿主侧做存在性与越界校验，拒绝 `/` 与家目录本身。

---

## HTTP API

全部挂在 `/x-ssh-explorer/` 下，共 19 条。GET：`connections` `ping` `info` `list` `read` `chat-models` `locals` `job`；其余是 POST。

| 端点 | 作用 |
|---|---|
| `GET/POST /connections` | 列连接（含 `readOnly`、`hasPassword`、`hidden`）；POST 支持 `save` / `delete` / `restore` |
| `GET /ping` | 连通性 + 认证探测 |
| `GET /info` | 主机名 / 内核 / glibc 等 |
| `GET /list?path=` | 列目录（名字、类型、大小、mtime） |
| `GET /read?path=` | 读文件（上限 512 KB，返回 base64） |
| `POST /write` | 写文件（原子替换 + `.re-bak`） |
| `POST /chat` | AI 对话（SSE 流式） |
| `GET /chat-models` | 可用模型（按提供商分组） |
| `POST /chat-config` | 读写对话默认模型 |
| `POST /exec` | 远端执行一条命令（带退出码与 cwd） |
| `GET /locals` | 本机桌面 / 下载 / 用户目录 |
| `POST /pull` | 远端 → 本机（起任务），`{connection, paths[], target}` |
| `POST /push` | 本机 → 远端（起任务），`{connection, dir, paths[]}` |
| `POST /upload` | 单文件字节流兜底上传（请求体就是文件内容） |
| `GET/POST /job` | 任务快照 / 取消 |
| `POST /reveal` | 在资源管理器中定位文件 |
| `POST /delete` | 删远端文件/文件夹（逐条返回结果） |
| `POST /create` | 新建空文件/空目录 |
| `POST /rename` | 重命名（原子、保元数据） |

---

## 配置文件与状态目录

运行时状态都在 `%USERPROFILE%\.dsh\ssh-explorer\`：

| 文件 | 内容 |
|---|---|
| `connections.json` | 你自建的连接（`~/.ssh/config` 的不在此列） |
| `secrets.json` | 每台主机的口令，**DPAPI 加密**（换机器/换账户解不开） |
| `hidden.json` | 从清单里隐藏掉的 `~/.ssh/config` 主机 |
| `chat.json` | AI 对话默认用哪个模型 / 网关（可选） |
| `askpass.cjs` `askpass.cmd` `dpapi.ps1` | 首次使用时自动生成的帮手脚本 |

> 从旧名 `dsh-remote-explorer`（≤1.6.1）升级过来时，`~/.dsh/remote-explorer` 会在首次启动时**自动整体搬过来**，连接和口令都不用重填。

---

## 跑测试

三套测试，都是零依赖的 Node 脚本：

```bash
node test_host.mjs      # 宿主半边 119 项（真 SSH：列目录、读写、口令、隐藏、exec…）
node test_client.mjs    # 客户端半边 217 项（自带迷你 React 替身，逐槽位断言渲染结果）
node test_transfer.mjs  # 传输 / 删除 / 新建 / 改名 端到端 39 项（真 ssh、真写盘）
```

- 需要一台能 `ssh` 上去的 Linux 机。默认取 `~/.ssh/config` 里第一台有 `host` 的；也可以指定：

  ```powershell
  $env:RE_TEST_HOST = "ubuntu-vm"     # 匹配连接名或 id
  node test_transfer.mjs
  ```

- 一台都没有时，`test_transfer.mjs` 会**整份跳过并 exit 0**（不算失败）。
- 传输测试会在 `%TEMP%\re-transfer-test` 与远端 `/tmp/re-e2e` 下建临时目录，跑完自己清。

---

## 已知限制

- **拖出不是系统级拖放**：不能把文件丢进别的应用窗口（壳禁了下载、也没暴露 `startDrag`）；落点固定桌面，行尾 `⬇`/右键「下载」是等价入口。
- **拖入必须松手在面板上**：列表空白处 = 当前目录，目录行 = 该目录；拖到面板外不会上传。
- **传输逐条串行**：一个任务里一条一条来，没有并发分片。
- 预览上限 512 KB；超大文件请下载。
- 远端终端是「一次性 exec」而不是常驻 PTY：每条命令独立，`cd` 不跨条保留（但会显示命令结束时的 cwd）。
- 不支持在本机侧重命名/移动，也不支持新建符号链接（远端可以）。
- 远端必须能用 `python3`；传文件夹必须有 GNU tar。

---

## 排错

| 症状 | 原因 / 处理 |
|---|---|
| 侧栏没有图标 / 打不开 | 装载块没生效：确认 `cordis.patch.yml` 里 `[ssh-explorer]` 块在、路径对，然后**完全退出 DSH 再开** |
| 改了代码没变化 | 客户端改了就刷新页面（并确认 `rev` 已 +1）；宿主改了必须重启 DSH |
| 端点 405 | 跑的是旧宿主代码（路由没注册）——重启 DSH |
| 连不上 | 先在本机终端 `ssh 目标` 试；注意 Windows 的 `ssh.exe` 与 WSL/Git 自带的可能不是同一个 |
| 口令总不对 | 用「🔑 设密码」单独存一条；`agent`/`key` 认证先试密钥再退口令 |
| 中文名变乱码 | 不要在链路上用 PowerShell 管道传二进制；本插件走的是自己的 tar 读写器，正常不会出现，若出现请贴 `ssh -V` 与远端 `tar --version` |
| 传输卡住 | 抽屉里点取消；宿主 30 分钟硬超时会自动收尾 |
| YAML 解析失败 | 文件被加了 BOM。用 VSCode/Notepad++ 存「UTF-8 无 BOM」 |

更多细节见 [docs/使用说明.md](docs/使用说明.md)。

---

## 目录结构

```
dsh-ssh-explorer/
├─ plugin/                  # 插件本体（拷进 profile 的就是这个目录）
│  ├─ package.json          # dsh.client 声明 + version
│  └─ lib/
│     ├─ index.js           # 宿主半边：19 条路由、ssh、tar 读写、任务队列
│     └─ client.js          # 客户端半边：侧栏面板、拖拽、键盘、浮层
├─ docs/
│  └─ 使用说明.md            # 完整手册（操作、端点、边界、踩坑）
├─ install.py               # 安装 / --verify / --rollback
├─ test_host.mjs            # 宿主半边测试（真 SSH）
├─ test_client.mjs          # 客户端渲染测试（迷你 React 替身）
├─ test_transfer.mjs        # 传输端到端测试（真 ssh、真写盘）
├─ validate_patch.mjs       # 校验 cordis.patch.yml 装载块
├─ CHANGELOG.md
└─ LICENSE
```

---

## 更新日志与许可

- 版本历史：[CHANGELOG.md](CHANGELOG.md)
- 许可：[MIT](LICENSE) © 2026 小乐子

> 说明：AI 对话功能会复用你在 DSH 里配置的模型与密钥，并且**允许模型在那台远端机上执行命令**。
> 这是设计使然（它就是拿来远程干活的），但也意味着别把不可信的模型接到生产机上。
