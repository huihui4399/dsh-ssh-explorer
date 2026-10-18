/**
 * dsh-ssh-explorer — host half.
 *
 * 给 DSH Web GUI 提供「SSH 远程资源管理器」的数据面：连接清单、远程目录列举、
 * 远程文件读取。客户端半边（`lib/client.js`）通过 `fetch()` 调用这里的路由。
 *
 * 设计要点（都由实测依据支撑）：
 *
 * - **零 `@deepseek-ai/*` 依赖。** 本地 `plugins/` 目录挂载的插件不会被 pnpm 装依赖，
 *   profile 的 `node_modules/@deepseek-ai/` 下只有 `cosmokit` 与 `schemastery`。
 *   因此这里只 import Node 内建模块，一切能力都从 Cordis 的 `ctx` 上取。
 * - **数据通道用 `ctx.webServer.register(route)`。** 路由形状是
 *   `{ kind: 'exact', path, handler(req, res) }`，返回 disposer。这是
 *   `@linxin666/dsh-remote-web-ui` 验证过的零依赖 HTTP 通道。
 * - **远程命令统一走 python3。** 目标机 Ubuntu 22.04 自带 python3.10.12，
 *   把脚本 base64 后 `| python3 - <参数>`，可以彻底绕开 Windows/SSH/远端 shell
 *   三重引号地狱，并且天然输出 JSON。
 *
 * @module dsh-ssh-explorer
 */

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Cordis 插件名。 */
export const name = "ssh-explorer";

/** 只依赖 webServer：注册路由用。 */
export const inject = ["webServer"];

/** 所有路由的路径前缀，避免和宿主路由撞车。 */
const ROUTE_PREFIX = "/x-ssh-explorer";

const SSH_CONFIG_PATH = join(homedir(), ".ssh", "config");
const DEFAULT_IDENTITY = join(homedir(), ".ssh", "id_ed25519");
const STORE_DIR = join(homedir(), ".dsh", "ssh-explorer");
const STORE_FILE = join(STORE_DIR, "connections.json");
/** 旧名（v1.6.x 及更早叫 dsh-remote-explorer）的状态目录，改名后一次性搬过来。 */
const LEGACY_STORE_DIR = join(homedir(), ".dsh", "remote-explorer");

/** ssh 的 askpass 帮手与 DPAPI 帮手都放在状态目录里，首次使用时生成。 */
const ASKPASS_JS = join(STORE_DIR, "askpass.cjs");
const ASKPASS_CMD = join(STORE_DIR, "askpass.cmd");
const DPAPI_PS1 = join(STORE_DIR, "dpapi.ps1");

const SSH_TIMEOUT_MS = 25000;
const MAX_READ_BYTES = 512 * 1024;

/** 允许的认证方式。`auto` 是有密钥就用密钥、否则再试密码/agent。 */
const AUTH_TYPES = new Set(["auto", "key", "password", "agent"]);

// ─────────────────────────────────────────────────────────── ssh 可执行文件

let sshBinaryCache;

/** 解析可用的 ssh 可执行文件；返回 null 表示都找不到。 */
function sshBinary() {
  if (sshBinaryCache !== undefined) return sshBinaryCache;
  const candidates = [
    "ssh",
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate === "ssh") {
      sshBinaryCache = "ssh";
      return sshBinaryCache;
    }
    if (existsSync(candidate)) {
      sshBinaryCache = candidate;
      return sshBinaryCache;
    }
  }
  sshBinaryCache = null;
  return sshBinaryCache;
}

/** Promise 化的 execFile，永远 resolve，不抛。 */
function run(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
      });
    });
  });
}

/**
 * 同 `run`，但把 `input` 写进子进程的 stdin。
 *
 * 用来传文件内容：Windows 的 `CreateProcess` 命令行上限是 32767 字符，
 * 走 argv 传大文件必然被截断，走 stdin 则没有长度限制。
 * `spawn` 没有 `timeout` 选项，所以这里自己起定时器杀进程，并把 `error.killed`
 * 置上，让调用方能按 `sshExec` 里同一套逻辑识别超时。
 */
function runWithInput(file, args, input, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve({ error, stdout, stderr, code: error ? 1 : 0 });
    };
    if (Number.isFinite(options.timeout) && options.timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 进程可能已经退出 */
        }
        finish(Object.assign(new Error("超时"), { killed: true }));
      }, options.timeout);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(code === 0 ? null : Object.assign(new Error(`退出码 ${code}`), { killed: false })));
    child.stdin.on("error", () => {
      /* 远端提前关闭管道时不要炸 */
    });
    child.stdin.end(input);
  });
}

/** POSIX 单引号转义：把 ' 变成 '\''。 */
function shq(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// ─────────────────────────────────────────────────────────── 凭据基础设施
//
// 目标：每条连接各自一套凭据，互不影响。
//
// - **口令存在 `secrets.json`**，按连接 id 索引，值是 **Windows DPAPI 加密**过的
//   base64（作用域 CurrentUser：只有本机本用户能解，复制到别的机器/别的账户就解不开）。
//   口令和连接定义分开存，所以 `~/.ssh/config` 里自动发现的机器也能单独设密码。
// - **解密结果在进程内缓存**，避免每次操作都启动一次 PowerShell（实测一次 371ms）。
// - 真正把口令喂给 ssh 的是 **askpass 机制**：OpenSSH 在需要口令时执行
//   `SSH_ASKPASS` 指向的程序，并把提示语当 argv[1] 传过去（实测 Windows OpenSSH
//   9.5p2 确实调用了它，argv[1] 形如 `admin@1.2.3.4's password: `）。
//   配合 `SSH_ASKPASS_REQUIRE=force`，即使有控制台也会走 askpass。

const ASKPASS_SOURCE = `// 由 dsh-ssh-explorer 自动生成：ssh 要口令时会执行这个脚本。
// 口令从 DSH_SSH_SECRET 环境变量读，走 stdout 交给 ssh。
const prompt = String(process.argv[2] ?? "");
const logFile = process.env.DSH_SSH_EXPLORER_ASKPASS_LOG;
if (logFile) {
  // 只记提示语，绝不记口令本身。排障时用来回答「ssh 到底有没有来问口令」。
  try {
    require("fs").appendFileSync(logFile, new Date().toISOString() + " " + JSON.stringify(prompt) + "\\n");
  } catch {}
}
const lowered = prompt.toLowerCase();
const hostKeyQuestion =
  lowered.includes("yes/no") ||
  lowered.includes("fingerprint") ||
  lowered.includes("continue connecting") ||
  lowered.includes("authenticity");
if (hostKeyQuestion) {
  process.stdout.write("yes\\n");
} else {
  process.stdout.write(String(process.env.DSH_SSH_SECRET ?? "") + "\\n");
}
`;

// ⚠ 这个 .ps1 刻意写成「纯 ASCII + 走命令行参数 + 结果落文件」。
//
// 三条都是踩过坑换来的：
//  1. 纯 ASCII —— Windows PowerShell 5.1 读没有 BOM 的 .ps1 时用的是 ANSI 代码页，
//     中文注释会变成乱码（实测会连带把 `$input` 那条路径搞坏）。
//  2. 走参数而不是 stdin —— 实测 powershell.exe 5.1 在 `-File` 下，
//     `[Console]::In.ReadToEnd()` 与 `[Console]::OpenStandardInput()` 都读到空串
//     （stdin 被 PowerShell 主机自己收走了）。而空入参极其阴险：
//     `Protect(空)` 照样返回一个合法的 230 字节 blob，错误要等到
//     `Unprotect` 才以 `The parameter is incorrect.` 的形式爆出来。
//  3. 结果落文件 —— stdout 在这条路径上同样不可靠。
const DPAPI_SOURCE = `param(
    [Parameter(Mandatory=$true)][ValidateSet('protect','unprotect')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$Payload,
    [Parameter(Mandatory=$true)][string]$OutFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$blob = [Convert]::FromBase64String($Payload)
if ($Mode -eq 'protect') {
    $out = [Security.Cryptography.ProtectedData]::Protect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
    $out = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[IO.File]::WriteAllText($OutFile, [Convert]::ToBase64String($out), [Text.Encoding]::ASCII)
`;

/** 进程内口令缓存：connectionId -> 明文口令（或 null 表示没有）。 */
const SECRET_CACHE = new Map();

let nodeExeCache;

/**
 * 给 askpass 用的 node 可执行文件。
 * 优先用 DSH 自带的运行时 node；退化到 Electron 主程序（那条路径需要
 * ELECTRON_RUN_AS_NODE=1，`.cmd` 里已经设了）。
 */
function nodeExe() {
  if (nodeExeCache !== undefined) return nodeExeCache;
  const candidates = [
    process.env.DSH_DESKTOP_NODE_EXECUTABLE,
    join(homedir(), ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "node", "bin", "node.exe"),
    process.execPath,
  ];
  nodeExeCache = candidates.find((item) => typeof item === "string" && item.length > 0 && existsSync(item)) ?? null;
  return nodeExeCache;
}

let powerShellExeCache;

/** 做 DPAPI 的 PowerShell。5.1 启动 371ms，比 pwsh 7 的 786ms 快一倍。 */
function powerShellExe() {
  if (powerShellExeCache !== undefined) return powerShellExeCache;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const full = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  powerShellExeCache = existsSync(full) ? full : "powershell.exe";
  return powerShellExeCache;
}

/** 只在内容真的不同时才写盘。 */
async function writeIfChanged(path, content) {
  try {
    if ((await readFile(path, "utf8")) === content) return;
  } catch {
    /* 文件不存在，直接写 */
  }
  await writeFile(path, content, "utf8");
}

let helpersReady;

/**
 * 把旧版的状态目录整体搬到新名字下（连接清单、DPAPI 口令、隐藏名单、askpass 帮手）。
 *
 * 只在「新目录不存在、旧目录存在」时动手，用的是同盘 rename（原子、瞬时）；
 * 失败就当作全新安装——最坏情况只是连接要重填，不会让插件起不来。
 */
function migrateLegacyStore() {
  try {
    if (existsSync(STORE_DIR) || !existsSync(LEGACY_STORE_DIR)) return true;
    mkdirSync(dirname(STORE_DIR), { recursive: true });
    renameSync(LEGACY_STORE_DIR, STORE_DIR);
    return true;
  } catch {
    return false;
  }
}

/** 生成 askpass 与 dpapi 帮手文件（幂等，只做一次）。 */
function ensureHelperFiles() {
  if (helpersReady === undefined) {
    helpersReady = (async () => {
      const node = nodeExe();
      if (node === null) throw new Error("找不到可用于 askpass 的 node 可执行文件");
      await mkdir(STORE_DIR, { recursive: true });
      const cmd = ["@echo off", 'set "ELECTRON_RUN_AS_NODE=1"', `"${node}" "${ASKPASS_JS}" %*`, ""].join("\r\n");
      await writeIfChanged(ASKPASS_JS, ASKPASS_SOURCE);
      await writeIfChanged(ASKPASS_CMD, cmd);
      await writeIfChanged(DPAPI_PS1, DPAPI_SOURCE);
    })().catch((error) => {
      helpersReady = undefined;
      throw error;
    });
  }
  return helpersReady;
}

/**
 * 跑一次 DPAPI。入参是 base64 的 ASCII（走命令行参数），结果是 base64（从文件读回）。
 *
 * 为什么不用 stdin/stdout：见 DPAPI_SOURCE 上面的注释。简言之 stdout 会丢尾部，
 * 而长度恰好还是 4 的倍数，于是解密时才报 `The parameter is incorrect.`；
 * `-Payload` 走 argv 拿到的字节数与进程内完全一致。
 */
async function dpapi(mode, payload) {
  await ensureHelperFiles();
  const stamp = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const outFile = join(STORE_DIR, `.dpapi-${stamp}.out`);
  try {
    const result = await run(
      powerShellExe(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        DPAPI_PS1,
        "-Mode",
        mode,
        "-Payload",
        payload,
        "-OutFile",
        outFile,
      ],
      { timeout: 20000, windowsHide: true },
    );
    if (result.code !== 0) {
      return { ok: false, message: (result.stderr || result.message || "PowerShell 执行失败").trim() };
    }
    let value;
    try {
      value = (await readFile(outFile, "ascii")).trim();
    } catch (error) {
      return { ok: false, message: `PowerShell 没有写出结果文件：${String(error?.message ?? error)}` };
    }
    if (value.length === 0) return { ok: false, message: "PowerShell 返回了空结果" };
    return { ok: true, value };
  } finally {
    // unprotect 时这个文件里是明文口令的 base64，读完立刻删掉。
    await rm(outFile, { force: true }).catch(() => {});
  }
}

/** 口令 -> DPAPI 密文（base64）。 */
async function encryptSecret(plain) {
  return dpapi("protect", Buffer.from(String(plain), "utf8").toString("base64"));
}

/** DPAPI 密文（base64） -> 口令。 */
async function decryptSecret(stored) {
  const result = await dpapi("unprotect", String(stored));
  if (!result.ok) return result;
  return { ok: true, value: Buffer.from(result.value, "base64").toString("utf8") };
}

/** 取某条连接的口令明文；没有就返回 null。带进程内缓存。 */
async function secretOf(connection) {
  const id = connection?.id;
  if (typeof id !== "string" || id.length === 0) return null;
  if (SECRET_CACHE.has(id)) return SECRET_CACHE.get(id);
  const secrets = await loadSecrets();
  const blob = secrets[id];
  if (typeof blob !== "string" || blob.length === 0) {
    SECRET_CACHE.set(id, null);
    return null;
  }
  const result = await decryptSecret(blob);
  const value = result.ok ? result.value : null;
  SECRET_CACHE.set(id, value);
  return value;
}

/** 口令变了就丢掉缓存。 */
function forgetSecret(id) {
  if (typeof id === "string" && id.length > 0) SECRET_CACHE.delete(id);
}

/**
 * 组装 ssh 调用的「可执行文件 + 参数 + 额外环境」。
 *
 * `sshExec`（要输出文本）与 `spawnSsh`（要裸管道搬文件）共用这一份，避免参数漂移。
 *
 * 认证按 `connection.authType` 分派，四种取值：
 *
 * | authType   | 行为 |
 * |------------|------|
 * | `auto`（默认） | 先试密钥；存了口令就再试密码（askpass 喂） |
 * | `key`      | 只用密钥；存了口令时用 askpass 解密钥口令 |
 * | `password` | 只用密码，关掉公钥，保证 askpass 只被问一次 |
 * | `agent`    | 走 ssh-agent，不进交互（BatchMode） |
 *
 * **没有存口令时一律用 `BatchMode=yes`**，这样认证失败会立刻返回错误，
 * 而不是卡在那儿等一个永远不会有人输入的密码。
 *
 * @param connection - { id, host, port, user, identityFile, authType }
 * @param remoteCommand - 远端 shell 命令
 * @param timeoutMs - 超时毫秒数
 * @param input - 可选；给了就写进 ssh 的 stdin（传文件内容用，不受命令行长度限制）
 * @returns { ok, stdout, stderr, message }
 */
async function sshContext(connection, remoteCommand) {
  const binary = sshBinary();
  if (binary === null) return null;

  const authType = AUTH_TYPES.has(connection.authType) ? connection.authType : "auto";
  const secret = await secretOf(connection);
  const useAskpass = typeof secret === "string" && secret.length > 0;

  const args = [
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
  ];

  if (authType === "password") {
    args.push("-o", "PubkeyAuthentication=no");
    args.push("-o", "PreferredAuthentications=password");
    args.push("-o", "NumberOfPasswordPrompts=1");
    // 没存口令时不能让它去问终端 —— 那里没人会回答，只会一直拖到超时。
    if (!useAskpass) args.push("-o", "BatchMode=yes");
  } else if (authType === "agent") {
    args.push("-o", "BatchMode=yes");
    args.push("-o", "PreferredAuthentications=publickey");
  } else if (authType === "key") {
    if (!useAskpass) args.push("-o", "BatchMode=yes");
    args.push("-o", "PreferredAuthentications=publickey");
  } else if (useAskpass) {
    args.push("-o", "PreferredAuthentications=publickey,password");
    args.push("-o", "NumberOfPasswordPrompts=1");
  } else {
    args.push("-o", "BatchMode=yes");
    args.push("-o", "PreferredAuthentications=publickey");
  }

  // 只用密码时不要再塞一个默认私钥进去，否则 ssh 仍会去试它。
  const identity =
    connection.identityFile || (authType === "password" ? undefined : DEFAULT_IDENTITY);
  if (identity) args.push("-i", identity);
  if (connection.port) args.push("-p", String(connection.port));

  const target = connection.user ? `${connection.user}@${connection.host}` : connection.host;
  args.push("--", target, remoteCommand);

  let env;
  if (useAskpass) {
    // SSH_ASKPASS_REQUIRE=force 让 ssh 即使有控制台也走 askpass；
    // DISPLAY 是老版本 ssh 决定是否使用 askpass 的开关，一并设上。
    await ensureHelperFiles();
    env = {
      ...process.env,
      SSH_ASKPASS: ASKPASS_CMD,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "localhost:0",
      DSH_SSH_SECRET: secret,
    };
  }

  return { binary, args, env };
}

/**
 * 连上一台主机执行命令并拿回输出（小结果用；大流量走 `spawnSsh`）。
 *
 * @param connection - { id, host, port, user, identityFile, authType }
 * @param remoteCommand - 远端 shell 命令
 * @param timeoutMs - 超时毫秒数
 * @param input - 可选；给了就写进 ssh 的 stdin（传文件内容用，不受命令行长度限制）
 * @returns { ok, stdout, stderr, message }
 */
async function sshExec(connection, remoteCommand, timeoutMs = SSH_TIMEOUT_MS, input = undefined) {
  const context = await sshContext(connection, remoteCommand);
  if (context === null) {
    return { ok: false, stdout: "", stderr: "", message: "找不到 ssh 可执行文件" };
  }

  const options = {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  };
  if (context.env) options.env = context.env;

  const result = input === undefined
    ? await run(context.binary, context.args, options)
    : await runWithInput(context.binary, context.args, input, options);
  if (result.error && result.error.killed) {
    return { ok: false, stdout: result.stdout, stderr: result.stderr, message: `超时（${timeoutMs / 1000}s）` };
  }
  if (result.error) {
    const detail = (result.stderr || result.error.message || "").trim();
    return { ok: false, stdout: result.stdout, stderr: result.stderr, message: detail || "ssh 执行失败" };
  }
  return { ok: true, stdout: result.stdout, stderr: result.stderr, message: "" };
}

/**
 * 把一段 Python 脚本送到远端执行并解析其 JSON 输出。
 * 用 `echo <b64> | base64 -d | python3 - <args...>` 规避所有引号问题。
 */
async function remotePython(connection, script, args = [], timeoutMs = SSH_TIMEOUT_MS) {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const argText = args.map(shq).join(" ");
  const command = `echo ${shq(encoded)} | base64 -d | python3 - ${argText}`;
  const result = await sshExec(connection, command, timeoutMs);
  if (!result.ok) return { ok: false, error: result.message };
  const text = result.stdout.trim();
  if (text.length === 0) {
    return { ok: false, error: result.stderr.trim() || "远端没有返回任何内容" };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `远端返回的不是 JSON：${text.slice(0, 400)}` };
  }
}

/**
 * 保存远程文本文件用的 Python。
 *
 * - **内容走 stdin**（`sys.stdin.buffer.read()`），所以不受命令行长度限制，也不会有引号问题；
 * - **先写同目录临时文件再 `os.replace` 原子替换**，中途断网不会留下半个文件；
 * - 覆盖前留一份 `<名字>.re-bak` 备份，原有权限位一并继承。
 */
const SAVE_PY = `
import json, os, pathlib, shutil, sys
target = pathlib.Path(os.path.expanduser(sys.argv[1]))
data = sys.stdin.buffer.read()
tmp = str(target) + '.re-tmp'
backup = None
old_mode = None
try:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        old_mode = target.stat().st_mode & 0o777
        backup = str(target) + '.re-bak'
        shutil.copy2(str(target), backup)
    with open(tmp, 'wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    if old_mode is not None:
        os.chmod(tmp, old_mode)
    os.replace(tmp, str(target))
    print(json.dumps({
        'ok': True,
        'path': str(target),
        'bytes': len(data),
        'existed': backup is not None,
        'backup': backup,
        'mode': oct(os.stat(str(target)).st_mode & 0o777),
    }, ensure_ascii=False))
except Exception as ex:
    try:
        os.remove(tmp)
    except Exception:
        pass
    print(json.dumps({'ok': False, 'error': str(ex), 'path': str(target)}, ensure_ascii=False))
`;

/**
 * 把内容写到远程文件。
 *
 * 脚本本身经 base64 走 argv（很小），文件内容走 **stdin 流**。
 * 远端命令形如 `python3 -c "$(printf %s <b64> | base64 -d)" <path>`：
 * 用 `-c` 而不是 `python3 -`，是为了让 python 的 stdin 留给文件内容。
 */
async function writeRemoteFile(connection, target, content, timeoutMs = SSH_TIMEOUT_MS * 4) {
  const encoded = Buffer.from(SAVE_PY, "utf8").toString("base64");
  const command = `python3 -c "$(printf %s ${shq(encoded)} | base64 -d)" ${shq(target)}`;
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
  const result = await sshExec(connection, command, timeoutMs, buffer);
  if (!result.ok) return { ok: false, error: result.message || "保存失败" };
  const text = result.stdout.trim();
  if (text.length === 0) {
    return { ok: false, error: result.stderr.trim() || "远端没有返回任何内容" };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `远端返回的不是 JSON：${text.slice(0, 400)}` };
  }
}

// ─────────────────────────────────────────────────────────── 拖拽传输

/**
 * 双向传输：远端目录 → 本机（默认桌面），本机文件/文件夹 → 远端目录。
 *
 * 三条硬约束决定了这里的实现（都来自实测）：
 *
 * 1. **落盘只能由宿主做。** DSH 桌面外壳在主进程的 `will-download` 里直接
 *    `preventDefault()`，`<a download>` 与 `window.open` 触发的下载全被拦掉；
 *    所以「拖到桌面」的落地做法是：面板把远端路径交给宿主，宿主自己写文件，
 *    再用 `explorer /select,` 把结果亮出来。
 * 2. **目录搬运必须自己拆 tar。** Windows 自带 `tar.exe` 是精简版 bsdtar 3.8.9，
 *    不认 `--hdrcharset`，按 GBK 解释 UTF-8 文件名会把「中文 目录」变成乱码；
 *    所以本机这一侧的 tar 读写都在 JS 里实现（`extractTarStream` /
 *    `writeTarStream`），远端只负责 `tar -cf -` 与 `tar -xf -`（GNU tar 1.34，
 *    UTF-8 locale，文件名按字节原样透传）。
 * 3. **传输要能撑大文件。** 全程走管道 + 背压，不整块进内存。
 *
 * 每次传输登记成一个 job，面板轮询 `/job` 取进度，`POST /job{cancel}` 能杀进程。
 */
const TAR_BLOCK = 512;
const JOB_KEEP_MS = 60 * 60 * 1000;
const JOB_MAX = 40;
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;
/** 单条删除的超时：递归删大目录可能久一点，但也别无限等。 */
const DELETE_TIMEOUT_MS = 2 * 60 * 1000;
/** 新建 / 重命名这种一次改一个名字的小操作，一两秒就该回来。 */
const MUTATE_TIMEOUT_MS = 60 * 1000;
const JOBS = new Map();

/** 远端 POSIX 路径的 dirname；不能用 node:path（那边是 Windows 语义）。 */
function posixDirname(value) {
  const text = String(value ?? "").replace(/\/+$/, "");
  const index = text.lastIndexOf("/");
  return index <= 0 ? "/" : text.slice(0, index);
}

/** 远端 POSIX 路径的 basename。 */
function posixBasename(value) {
  const text = String(value ?? "").replace(/\/+$/, "");
  const index = text.lastIndexOf("/");
  return index < 0 ? text : text.slice(index + 1);
}

/** 远端 POSIX 路径拼接（base 为空时按根处理）。 */
function posixJoin(base, relative) {
  const head = String(base ?? "").replace(/\/+$/, "");
  const tail = String(relative ?? "").replace(/^\/+/, "");
  if (tail.length === 0) return head.length === 0 ? "/" : head;
  return `${head}/${tail}`;
}

/**
 * 把一段名字变成 Windows 能接受的文件/目录名。
 *
 * 除了 `<>:"|?*` 与控制字符，末尾的点和空格在 Windows 上会被静默吃掉，
 * 而 `CON`/`NUL`/`COM1` 这类设备名建不出文件 —— 都要在落地前改掉。
 */
function sanitizeSegment(segment) {
  let text = String(segment ?? "").replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/[. ]+$/, "");
  if (text.length === 0) text = "_";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(text)) text = `_${text}`;
  return text;
}

/** tar 里的名字 → 安全的相对路径；绝对路径与 `..` 一律拒绝。 */
function safeRelativePath(name) {
  const segments = String(name ?? "")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === ".." || /^[A-Za-z]:/.test(segment))) return null;
  return segments.map(sanitizeSegment).join("/");
}

/** Windows 路径上限 260 字符，深目录要加 `\\?\` 前缀。 */
function toLongPath(value) {
  const text = String(value ?? "");
  if (process.platform !== "win32") return text;
  if (text.startsWith("\\\\?\\")) return text;
  if (text.length < 240) return text;
  return /^[A-Za-z]:[\\/]/.test(text) ? `\\\\?\\${text}` : text;
}

/** 还原 mtime；失败无所谓，时间戳不是关键。 */
async function touchTime(path, seconds) {
  const stamp = Number(seconds);
  if (!Number.isFinite(stamp) || stamp <= 0) return;
  try {
    await utimes(path, stamp, stamp);
  } catch {
    /* 某些文件系统不接受时间戳，忽略 */
  }
}

/**
 * 问 PowerShell 要系统壳文件夹的真实路径。
 *
 * 用户可能把「桌面」重定向到了 D 盘，靠 `%USERPROFILE%\Desktop` 猜会错。
 * 输出用 base64 传回来：`-Command` 的 stdout 走控制台代码页，中文路径直接读会乱码。
 */
async function knownFolder(folder) {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=[Environment]::GetFolderPath('${folder}')`,
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))",
  ].join("; ");
  const result = await run(powerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 8000,
    windowsHide: true,
  });
  const text = String(result.stdout ?? "").trim();
  if (text.length === 0) return "";
  try {
    return Buffer.from(text, "base64").toString("utf8").trim();
  } catch {
    return "";
  }
}

let localDirsCache = null;

/** 本机的家目录 / 桌面 / 下载目录（传输的两个默认落点）。 */
async function localDirs() {
  if (localDirsCache !== null) return localDirsCache;
  const home = homedir();
  const desktop = process.platform === "win32" ? await knownFolder("Desktop") : "";
  localDirsCache = {
    home,
    desktop: desktop.length > 0 ? desktop : join(home, "Desktop"),
    downloads: join(home, "Downloads"),
    platform: process.platform,
  };
  return localDirsCache;
}

/** 落点解析：desktop / downloads 是别名，其余按绝对路径并用 mkdir -p 建出来。 */
async function resolvePullTarget(target) {
  const dirs = await localDirs();
  const text = String(target ?? "").trim();
  let dir;
  if (text.length === 0 || text === "desktop") dir = dirs.desktop;
  else if (text === "downloads") dir = dirs.downloads;
  else if (isAbsolute(text)) dir = text;
  else return { ok: false, message: "落点必须是绝对路径，或 desktop / downloads" };
  try {
    await mkdir(toLongPath(dir), { recursive: true });
    return { ok: true, dir };
  } catch (error) {
    return { ok: false, message: `建不了目录 ${dir}：${String(error?.message ?? error)}` };
  }
}

/** 从流里按需取字节的读缓冲（tar 解析用）。 */
class ByteReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.ended = false;
  }

  async fill(target) {
    while (this.buffer.length < target && !this.ended) {
      const next = await this.iterator.next();
      if (next.done === true) {
        this.ended = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }
    return this.buffer.length;
  }

  async read(count) {
    if (count <= 0) return Buffer.alloc(0);
    await this.fill(count);
    const slice = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return slice;
  }

  async skip(count) {
    let left = count;
    while (left > 0) {
      const chunk = await this.read(Math.min(left, 256 * 1024));
      if (chunk.length === 0) return false;
      left -= chunk.length;
    }
    return true;
  }
}

/** 解析 tar 头里的八进制字段；首字节带 0x80 的是 base-256（超大文件）。 */
function octalOf(buffer, offset, length) {
  if (length <= 0) return 0;
  if ((buffer[offset] & 0x80) !== 0) {
    let value = 0;
    for (let index = offset + 1; index < offset + length; index += 1) value = value * 256 + buffer[index];
    return value;
  }
  const text = buffer
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8) || 0;
}

/** 取 NUL 结尾的字段，按 UTF-8 解码（GNU tar 在 UTF-8 locale 下原样写字节）。 */
function cStringOf(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
}

/** 校验头块的 checksum（chksum 字段按空格计）。 */
function tarChecksumOk(block) {
  const stored = octalOf(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  return stored === sum;
}

/**
 * 把 tar 流解到 `destDir`。
 *
 * 只认普通文件、目录、符号链接；设备文件与 FIFO 直接跳过并在报告里说明。
 * 文件先写进 `*.re-dl-tmp` 再 rename，中断不会留下半个文件。
 *
 * @param stream - 可读流（ssh 的 stdout）
 * @param destDir - 落点绝对路径
 * @param onBytes - 进度回调（累计字节）
 * @returns { files, dirs, links, bytes, skipped }
 */
async function extractTarStream(stream, destDir, onBytes) {
  const reader = new ByteReader(stream);
  const report = { files: 0, dirs: 0, links: 0, bytes: 0, skipped: [] };
  let overrides = {};

  for (;;) {
    const block = await reader.read(TAR_BLOCK);
    if (block.length < TAR_BLOCK) break;
    let allZero = true;
    for (let index = 0; index < TAR_BLOCK; index += 1) {
      if (block[index] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;
    // 结尾可能只写了一个不完整的块；能读满却不是合法头就收工
    if (!tarChecksumOk(block)) break;

    const type = String.fromCharCode(block[156] === 0 ? 0x30 : block[156]);
    const size = octalOf(block, 124, 12);
    const mtime = octalOf(block, 136, 12);
    const padBytes = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
    let name = cStringOf(block, 0, 100);
    const prefix = cStringOf(block, 345, 155);
    if (prefix.length > 0) name = `${prefix}/${name}`;
    let linkname = cStringOf(block, 157, 100);

    // GNU 长名 / pax 扩展头：只改下一个条目的名字，自己不含内容
    if (type === "L" || type === "K" || type === "x" || type === "g") {
      const payload = await reader.read(size);
      await reader.skip(padBytes);
      const text = payload.toString("utf8").replace(/\0+$/, "");
      if (type === "L") overrides.name = text;
      else if (type === "K") overrides.linkname = text;
      else {
        for (const line of text.split("\n")) {
          const matched = /^(\d+) ([^=]+)=(.*)$/.exec(line);
          if (matched === null) continue;
          if (matched[2] === "path") overrides.name = matched[3];
          else if (matched[2] === "linkpath") overrides.linkname = matched[3];
        }
      }
      continue;
    }

    if (typeof overrides.name === "string") name = overrides.name;
    if (typeof overrides.linkname === "string") linkname = overrides.linkname;
    overrides = {};

    const relative = safeRelativePath(name);
    if (relative === null) {
      await reader.skip(size + padBytes);
      report.skipped.push({ path: name, reason: "路径不安全，已跳过" });
      continue;
    }
    const target = toLongPath(join(destDir, relative));

    if (type === "5") {
      await mkdir(target, { recursive: true });
      await touchTime(target, mtime);
      report.dirs += 1;
      await reader.skip(size + padBytes);
      continue;
    }

    if (type === "2") {
      try {
        await mkdir(toLongPath(dirname(target)), { recursive: true });
        await symlink(linkname, target);
        report.links += 1;
      } catch {
        report.skipped.push({ path: relative, reason: `符号链接 → ${linkname}（Windows 建不了，已跳过）` });
      }
      await reader.skip(size + padBytes);
      continue;
    }

    if (type !== "0" && type !== "7" && type !== "1") {
      await reader.skip(size + padBytes);
      report.skipped.push({ path: relative, reason: `不支持的类型 ${type}` });
      continue;
    }

    if (type === "1") {
      // 硬链接：在 Windows 上按普通文件重建没有意义，留个说明即可
      await reader.skip(size + padBytes);
      report.skipped.push({ path: relative, reason: "硬链接，已跳过" });
      continue;
    }

    await mkdir(toLongPath(dirname(target)), { recursive: true });
    const staging = toLongPath(`${target}.re-dl-tmp`);
    const output = createWriteStream(staging);
    const closed = new Promise((settle, fail) => {
      output.on("close", settle);
      output.on("error", fail);
    });
    try {
      let written = 0;
      while (written < size) {
        const chunk = await reader.read(Math.min(size - written, 256 * 1024));
        if (chunk.length === 0) throw new Error("tar 流意外结束");
        written += chunk.length;
        report.bytes += chunk.length;
        if (onBytes !== undefined) onBytes(report.bytes);
        if (!output.write(chunk)) await once(output, "drain");
      }
      output.end();
      await closed;
      if (existsSync(toLongPath(target))) await rm(toLongPath(target), { recursive: true, force: true });
      await rename(staging, target);
      await touchTime(target, mtime);
      report.files += 1;
    } catch (error) {
      try {
        output.destroy();
      } catch {
        /* 已关闭 */
      }
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
    await reader.skip(padBytes);
  }

  return report;
}

/** 按字节上限截断 UTF-8 文本，不切碎多字节字符。 */
function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return buffer;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end);
}

/** 写八进制字段：length-1 位数字 + NUL。 */
function writeOctalField(buffer, value, offset, length) {
  const safe = Math.max(0, Math.floor(Number(value) || 0));
  const text = safe.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

/** checksum（chksum 字段按空格参与求和）。 */
function tarChecksum(header) {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) sum += header[index];
  return sum;
}

/** 把 checksum 写进头块（6 位八进制 + NUL + 空格，老 tar 也认）。 */
function stampChecksum(header) {
  header.fill(0x20, 148, 156);
  header.write(tarChecksum(header).toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

/** 补齐到 512 的整数倍。 */
function padToBlock(buffer) {
  const remainder = buffer.length % TAR_BLOCK;
  if (remainder === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(TAR_BLOCK - remainder)]);
}

/** 组一个 ustar 头块。 */
function tarHeader(fields) {
  const header = Buffer.alloc(TAR_BLOCK);
  truncateUtf8(fields.name, 100).copy(header, 0);
  writeOctalField(header, fields.mode ?? 0o644, 100, 8);
  writeOctalField(header, 0, 108, 8);
  writeOctalField(header, 0, 116, 8);
  writeOctalField(header, fields.size ?? 0, 124, 12);
  writeOctalField(header, Math.floor((fields.mtimeMs ?? Date.now()) / 1000), 136, 12);
  header.write(fields.type ?? "0", 156, "ascii");
  if (typeof fields.linkname === "string" && fields.linkname.length > 0) {
    truncateUtf8(fields.linkname, 100).copy(header, 157);
  }
  header.write("ustar", 257, "ascii");
  header[262] = 0;
  header.write("00", 263, "ascii");
  stampChecksum(header);
  return header;
}

/**
 * GNU `@LongLink` 扩展头（type `L`）。
 *
 * 名字超过 100 字节时先发一块这个，真正的头里只放截断名；
 * GNU tar 会用它覆盖下一个条目的名字 —— 中文目录名基本都会走到这里。
 */
function gnuLongEntry(text, type) {
  const payload = Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
  const header = Buffer.alloc(TAR_BLOCK);
  header.write("././@LongLink", 0, "ascii");
  writeOctalField(header, 0o644, 100, 8);
  writeOctalField(header, 0, 108, 8);
  writeOctalField(header, 0, 116, 8);
  writeOctalField(header, payload.length, 124, 12);
  writeOctalField(header, Math.floor(Date.now() / 1000), 136, 12);
  header.write(type, 156, "ascii");
  header.write("ustar  ", 257, "ascii");
  stampChecksum(header);
  return [header, padToBlock(payload)];
}

/**
 * 往可写流里写一个 tar 归档（本机 → 远端用）。
 *
 * @param writable - ssh 的 stdin
 * @param items - [{ name, size, mode, mtimeMs, type, linkname, source }]
 * @param onBytes - 进度回调（累计字节）
 */
async function writeTarStream(writable, items, onBytes) {
  let sent = 0;
  const push = async (buffer) => {
    if (!writable.write(buffer)) await once(writable, "drain");
  };

  for (const item of items) {
    if (Buffer.byteLength(item.name, "utf8") > 100) {
      for (const part of gnuLongEntry(item.name, "L")) await push(part);
    }
    await push(
      tarHeader({
        name: item.name,
        size: item.size,
        mode: item.mode,
        mtimeMs: item.mtimeMs,
        type: item.type,
        linkname: item.linkname,
      }),
    );
    if (item.type === "0" && item.size > 0 && typeof item.source === "string") {
      let written = 0;
      const stream = createReadStream(item.source, { highWaterMark: 256 * 1024 });
      for await (const chunk of stream) {
        written += chunk.length;
        sent += chunk.length;
        if (onBytes !== undefined) onBytes(sent);
        await push(chunk);
      }
      const remainder = written % TAR_BLOCK;
      if (remainder !== 0) await push(Buffer.alloc(TAR_BLOCK - remainder));
    }
  }

  await push(Buffer.alloc(TAR_BLOCK * 2));
  writable.end();
}

/** 递归收集一个本机路径下的所有条目（保持名字相对 root 的父目录）。 */
async function collectTarItems(rootPath, baseName) {
  const items = [];
  const visit = async (absPath, relative, depth) => {
    if (depth > 64) return;
    const stats = await stat(absPath);
    if (stats.isDirectory()) {
      items.push({
        name: `${relative}/`,
        type: "5",
        mode: 0o755,
        mtimeMs: stats.mtimeMs,
        size: 0,
      });
      const entries = await readdir(absPath, { withFileTypes: true });
      for (const entry of entries) {
        await visit(join(absPath, entry.name), `${relative}/${entry.name}`, depth + 1);
      }
      return;
    }
    if (stats.isFile()) {
      items.push({
        name: relative,
        type: "0",
        mode: 0o644,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        source: absPath,
      });
    }
    // 符号链接被 stat 跟随成文件/目录；其它特殊文件没有可搬的意义，跳过
  };
  await visit(rootPath, baseName, 0);
  return items;
}

/** 递归求目录字节数，给进度条一个分母。 */
async function dirSize(rootPath, depth = 0) {
  if (depth > 64) return 0;
  let total = 0;
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const target = join(rootPath, entry.name);
    if (entry.isDirectory()) total += await dirSize(target, depth + 1);
    else if (entry.isFile()) {
      try {
        total += (await stat(target)).size;
      } catch {
        /* 竞态：文件刚被删掉 */
      }
    }
  }
  return total;
}

/**
 * 远端收文件的 Python 脚本。
 *
 * 为什么不直接 `cat > 文件`：要 a) 自动建父目录，b) 先写 tmp 再 rename（中断不留半个文件），
 * c) 保 mtime，d) 已存在时默认不覆盖并如实报告。
 *
 * **参数走环境变量，脚本本体走 `python3 -c` 的 argv。** 这一步很关键：如果用
 * 惯常的 `base64 -d | python3 -`，脚本自己就吃掉了 ssh 的 stdin，文件数据一个字也进不来
 * （第一版就是这么挂的，实测远端写出 0 字节）。
 */
const UPLOAD_PY = `import json, os, sys, pathlib
target = pathlib.Path(os.environ["RE_TARGET"])
mtime = os.environ.get("RE_MTIME", "")
overwrite = os.environ.get("RE_OVERWRITE", "0") == "1"
staging = str(target) + ".re-up-tmp"
existed = target.exists()
try:
    if existed and not overwrite:
        sys.stdin.buffer.read()
        print(json.dumps({"ok": False, "exists": True, "error": "目标已存在：" + str(target)}, ensure_ascii=False))
        sys.exit(0)
    target.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with open(staging, "wb") as handle:
        while True:
            chunk = sys.stdin.buffer.read(262144)
            if not chunk:
                break
            handle.write(chunk)
            total += len(chunk)
        handle.flush()
        os.fsync(handle.fileno())
    if mtime:
        try:
            stamp = float(mtime)
            os.utime(staging, (stamp, stamp))
        except Exception:
            pass
    os.replace(staging, str(target))
    print(json.dumps({"ok": True, "path": str(target), "bytes": total, "existed": existed}, ensure_ascii=False))
except Exception as error:
    try:
        os.remove(staging)
    except Exception:
        pass
    print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
`;

/** 远端收单个文件的完整命令（stdin 留给文件内容）。 */
function remoteUploadCommand(target, mtimeMs, overwrite) {
  const payload = Buffer.from(UPLOAD_PY, "utf8").toString("base64");
  const stamp = Number.isFinite(mtimeMs) && mtimeMs > 0 ? (mtimeMs / 1000).toFixed(3) : "";
  const bootstrap = shq("import base64,sys;exec(base64.b64decode(sys.argv[1]))");
  return [
    `RE_TARGET=${shq(target)}`,
    `RE_MTIME=${shq(stamp)}`,
    `RE_OVERWRITE=${overwrite ? "1" : "0"}`,
    `python3 -c ${bootstrap} ${payload}`,
  ].join(" ");
}

/** 远端展开 tar 的命令（stdin 是 tar 流）。 */
function remoteExtractCommand(dir) {
  return `mkdir -p ${shq(dir)} && tar -xf - -C ${shq(dir)}`;
}

/**
 * 起一个 ssh 子进程，把管道交给调用方。
 *
 * 与 `sshExec` 的区别：不缓冲输出、不设总超时（大文件要传很久），
 * 只挂一个 `TRANSFER_TIMEOUT_MS` 的兜底硬超时，防止远端卡死时任务永远 running。
 */
async function spawnSsh(connection, remoteCommand, timeoutMs = TRANSFER_TIMEOUT_MS, captureStdout = false) {
  const context = await sshContext(connection, remoteCommand);
  if (context === null) throw new Error("找不到 ssh 可执行文件");
  const options = { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
  if (context.env) options.env = context.env;
  const child = spawn(context.binary, context.args, options);
  const stderrChunks = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    if (stderrBytes < 8192) {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    }
  });
  const stdoutChunks = [];
  if (captureStdout) {
    child.stdout.on("data", (chunk) => {
      if (stdoutChunks.length < 256) stdoutChunks.push(chunk);
    });
  }
  // 对端提前关闭管道时不要炸
  child.stdin.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* 进程已退出 */
          }
        }, timeoutMs)
      : null;
  const done = new Promise((settle) => {
    child.on("error", (error) => settle({ code: -1, stderr: String(error?.message ?? error) }));
    child.on("close", (code) =>
      settle({ code: code === null ? -1 : code, stderr: Buffer.concat(stderrChunks).toString("utf8").trim() }),
    );
  }).then((result) => {
    if (timer !== null) clearTimeout(timer);
    return { ...result, stdout: Buffer.concat(stdoutChunks).toString("utf8") };
  });
  return { child, done };
}

/** 建一个传输任务。 */
function createJob(kind, title) {
  const job = {
    id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    title,
    state: "running",
    phase: "准备中",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    items: [],
    bytes: 0,
    total: 0,
    message: "",
    target: "",
    openPath: "",
    cancelRequested: false,
    children: [],
  };
  JOBS.set(job.id, job);
  for (const [key, value] of JOBS) {
    if (Date.now() - value.updatedAt > JOB_KEEP_MS || JOBS.size > JOB_MAX) JOBS.delete(key);
    if (JOBS.size <= JOB_MAX) break;
  }
  return job;
}

/** 给面板的快照（去掉子进程句柄）。 */
function jobSnapshot(job) {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    state: job.state,
    phase: job.phase,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    items: job.items.map((item) => ({ ...item })),
    bytes: job.bytes,
    total: job.total,
    message: job.message,
    target: job.target,
    openPath: job.openPath,
    cancelRequested: job.cancelRequested,
  };
}

/** 重算任务总进度。 */
function refreshJobBytes(job) {
  let bytes = 0;
  let total = 0;
  for (const item of job.items) {
    bytes += Number(item.bytes) || 0;
    total += Number(item.total) || 0;
  }
  job.bytes = bytes;
  job.total = total;
  job.updatedAt = Date.now();
}

/** 收尾。 */
function settleJob(job, state, message = "") {
  job.state = state;
  job.phase = state === "done" ? "完成" : state === "failed" ? "失败" : "已取消";
  job.message = message;
  job.updatedAt = Date.now();
  job.children = [];
}

/**
 * 赶一个「远端 → 本机」任务。
 *
 * 每个远端路径起一条 `cd <父目录> && tar -cf - -- <名字>`，
 * 输出直接喂给 `extractTarStream` 落到落点目录。
 */
async function runPullJob(job, connection, remotePaths, destDir, overwrite) {
  job.phase = `下载 ${remotePaths.length} 项`;
  try {
    await mkdir(toLongPath(destDir), { recursive: true });
    for (const remotePath of remotePaths) {
      if (job.cancelRequested) {
        settleJob(job, "cancelled", "已取消");
        return;
      }
      const name = posixBasename(remotePath);
      const item = {
        label: name,
        remote: remotePath,
        state: "running",
        bytes: 0,
        total: 0,
        error: "",
        local: "",
      };
      job.items.push(item);
      job.phase = `下载 ${name}`;
      const localPath = join(destDir, sanitizeSegment(name));
      if (existsSync(toLongPath(localPath))) {
        if (!overwrite) {
          item.state = "failed";
          item.error = "本机已有同名文件/文件夹（可在设置里允许覆盖）";
          job.updatedAt = Date.now();
          continue;
        }
        await rm(toLongPath(localPath), { recursive: true, force: true }).catch(() => undefined);
      }
      const parent = posixDirname(remotePath);
      const { child, done } = await spawnSsh(connection, `cd ${shq(parent)} && tar -cf - -- ${shq(name)}`);
      job.children.push(child);
      try {
        const report = await extractTarStream(child.stdout, destDir, (bytes) => {
          item.bytes = bytes;
          refreshJobBytes(job);
        });
        const result = await done;
        if (result.code !== 0 && report.files === 0 && report.dirs === 0) {
          throw new Error(result.stderr || `远端 tar 退出码 ${result.code}`);
        }
        item.state = "done";
        item.bytes = report.bytes;
        item.total = report.bytes;
        item.local = localPath;
        item.files = report.files;
        item.dirs = report.dirs;
        if (report.skipped.length > 0) item.note = `${report.skipped.length} 项未还原：${report.skipped[0].reason}`;
        job.openPath = localPath;
      } catch (error) {
        item.state = job.cancelRequested ? "cancelled" : "failed";
        item.error = job.cancelRequested ? "已取消" : String(error?.message ?? error);
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
      } finally {
        job.children = job.children.filter((handle) => handle !== child);
        refreshJobBytes(job);
      }
    }
    const failed = job.items.filter((item) => item.state === "failed").length;
    if (job.cancelRequested) settleJob(job, "cancelled", "已取消");
    else settleJob(job, failed > 0 && failed === job.items.length ? "failed" : "done", failed > 0 ? `${failed} 项失败` : "");
  } catch (error) {
    settleJob(job, "failed", String(error?.message ?? error));
  }
}

/**
 * 赶一个「本机 → 远端」任务。
 *
 * 文件夹走 tar 流（一次 ssh 搬完，保住目录结构与 mtime），
 * 单文件走 `UPLOAD_PY`（先 tmp 后 rename，已存在时如实报告）。
 */
async function runPushJob(job, connection, remoteDir, localPaths, overwrite) {
  job.phase = `上传到 ${remoteDir}`;
  try {
    for (const localPath of localPaths) {
      if (job.cancelRequested) {
        settleJob(job, "cancelled", "已取消");
        return;
      }
      const name = basename(localPath);
      const item = { label: name, remote: posixJoin(remoteDir, name), state: "running", bytes: 0, total: 0, error: "" };
      job.items.push(item);
      job.phase = `上传 ${name}`;
      try {
        const stats = await stat(localPath);
        item.total = stats.isDirectory() ? await dirSize(localPath) : stats.size;
        if (stats.isDirectory()) {
          const { child, done } = await spawnSsh(connection, remoteExtractCommand(remoteDir));
          job.children.push(child);
          try {
            const items = await collectTarItems(localPath, name);
            await writeTarStream(child.stdin, items, (bytes) => {
              item.bytes = bytes;
              refreshJobBytes(job);
            });
            const result = await done;
            if (result.code !== 0) throw new Error(result.stderr || `远端 tar 退出码 ${result.code}`);
          } finally {
            job.children = job.children.filter((handle) => handle !== child);
          }
          item.state = "done";
          item.bytes = item.total;
        } else {
          const target = posixJoin(remoteDir, name);
          const { child, done } = await spawnSsh(
            connection,
            remoteUploadCommand(target, stats.mtimeMs, overwrite),
            TRANSFER_TIMEOUT_MS,
            true,
          );
          job.children.push(child);
          try {
            const stream = createReadStream(localPath, { highWaterMark: 256 * 1024 });
            let sent = 0;
            stream.on("data", (chunk) => {
              sent += chunk.length;
              item.bytes = sent;
              refreshJobBytes(job);
            });
            stream.pipe(child.stdin);
            const result = await done;
            const parsed = parseJsonLine(result);
            if (parsed !== null && parsed.ok === false) {
              throw new Error(parsed.exists === true ? "远端已有同名文件（可允许覆盖后重试）" : String(parsed.error ?? "远端写入失败"));
            }
            if (result.code !== 0) throw new Error(result.stderr || `ssh 退出码 ${result.code}`);
          } finally {
            job.children = job.children.filter((handle) => handle !== child);
          }
          item.state = "done";
          item.bytes = item.total;
        }
      } catch (error) {
        item.state = "failed";
        item.error = String(error?.message ?? error);
      } finally {
        refreshJobBytes(job);
      }
    }
    const failed = job.items.filter((item) => item.state === "failed").length;
    if (job.cancelRequested) settleJob(job, "cancelled", "已取消");
    else settleJob(job, failed > 0 && failed === job.items.length ? "failed" : "done", failed > 0 ? `${failed} 项失败` : "");
  } catch (error) {
    settleJob(job, "failed", String(error?.message ?? error));
  }
}

/** 从「命令输出 + 退出码」里取出最后一行 JSON（远端脚本的回报）。 */
function parseJsonLine(result) {
  const text = String(result?.stdout ?? "").trim();
  if (text.length === 0) return null;
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* 继续往上找 */
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────── 连接清单

/** 解析 ~/.ssh/config，取出可用的 Host 别名。 */
function parseSshConfig(text) {
  const hosts = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const match = /^(\S+)[\s=]+(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "host") {
      const first = value.split(/\s+/)[0];
      if (first.includes("*") || first.includes("?") || first.includes("!")) {
        current = null;
        continue;
      }
      current = { alias: first, host: first, port: undefined, user: undefined, identityFile: undefined };
      hosts.push(current);
      continue;
    }
    if (current === null) continue;
    if (key === "hostname") current.host = value;
    else if (key === "user") current.user = value;
    else if (key === "port") current.port = Number(value) || undefined;
    else if (key === "identityfile") current.identityFile = value.replace(/^~/, homedir());
  }
  return hosts;
}

/** 读取 ~/.ssh/config 里的主机；文件不存在时返回空数组。 */
async function sshConfigHosts() {
  if (!existsSync(SSH_CONFIG_PATH)) return [];
  try {
    const text = await readFile(SSH_CONFIG_PATH, "utf8");
    return parseSshConfig(text);
  } catch {
    return [];
  }
}

/** 读用户自己存的连接。 */
async function loadStoredConnections() {
  if (!existsSync(STORE_FILE)) return [];
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 写用户自己存的连接。 */
async function saveStoredConnections(list) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_FILE, `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

/**
 * 「已删除」清单：{ [connectionId]: { id, name, host, hiddenAt } }。
 *
 * ~/.ssh/config 是用户手写的文件，插件不擅自改写它；所以删掉一台从 config 里发现的
 * 主机时，只在这里记一笔把它从清单里隐藏。自建连接照旧从 connections.json 里真删。
 */
const HIDDEN_FILE = join(STORE_DIR, "hidden.json");

/** 读「已删除」清单。 */
async function loadHidden() {
  if (!existsSync(HIDDEN_FILE)) return {};
  try {
    const parsed = JSON.parse(await readFile(HIDDEN_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 写「已删除」清单；名单空了就把文件也删掉，不留空壳。 */
async function saveHidden(map) {
  if (Object.keys(map).length === 0) {
    try {
      await rm(HIDDEN_FILE, { force: true });
    } catch {
      /* 删不掉也不影响使用 */
    }
    return;
  }
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(HIDDEN_FILE, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

/** 口令文件：{ connectionId: "<DPAPI base64>" }。和连接定义分开，便于给自动发现的机器也设密码。 */
const SECRETS_FILE = join(STORE_DIR, "secrets.json");

/** 读口令表。 */
async function loadSecrets() {
  if (!existsSync(SECRETS_FILE)) return {};
  try {
    const parsed = JSON.parse(await readFile(SECRETS_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 写口令表。 */
async function saveSecrets(map) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(SECRETS_FILE, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

/**
 * 合并两份来源的连接清单。
 * 用户自建的连接优先，并给 ssh config 里的主机打 `source: "ssh-config"`。
 * 每条都补上 `authType` 与 `hasPassword`，供前端显示。
 */
async function mergedConnections() {
  const stored = await loadStoredConnections();
  const fromConfig = await sshConfigHosts();
  const secrets = await loadSecrets();
  const hidden = await loadHidden();
  const seen = new Set(stored.map((item) => item.id));
  // 删过的一律不出现（连 resolveConnection 也找不到它，避免残留的 tab 还能连）。
  const raw = stored.filter((item) => !(item.id in hidden));
  for (const item of fromConfig) {
    const id = `ssh-config:${item.alias}`;
    if (seen.has(id)) continue;
    if (id in hidden) continue;
    raw.push({
      id,
      name: item.alias,
      host: item.host,
      port: item.port,
      user: item.user,
      identityFile: item.identityFile,
      source: "ssh-config",
      readOnly: true,
    });
  }
  return raw.map((item) => ({
    ...item,
    authType: AUTH_TYPES.has(item.authType) ? item.authType : "auto",
    hasPassword: typeof secrets[item.id] === "string" && secrets[item.id].length > 0,
  }));
}

/** 按 id 找一台；id 形如 `ssh-config:ubuntu` 或用户自建 id。 */
async function resolveConnection(id) {
  const all = await mergedConnections();
  return all.find((item) => item.id === id) ?? null;
}

/** 把存下来的连接补全成 ssh 参数。 */
function toSshTarget(connection) {
  return {
    id: connection.id,
    host: connection.host,
    port: connection.port,
    user: connection.user,
    authType: connection.authType,
    identityFile: connection.identityFile,
  };
}

// ─────────────────────────────────────────────────────────── 远端 Python

/** 列目录。argv[1] = 路径（空串表示家目录）。 */
const LIST_PY = `
import os, json, sys
raw = sys.argv[1] if len(sys.argv) > 1 else ''
path = os.path.expanduser(raw) if raw else os.path.expanduser('~')
try:
    path = os.path.abspath(path)
    entries = []
    with os.scandir(path) as it:
        for e in it:
            item = {'name': e.name}
            try:
                st = e.stat(follow_symlinks=False)
                item['size'] = st.st_size
                item['mtime'] = int(st.st_mtime)
                item['mode'] = oct(st.st_mode & 0o777)[2:]
            except OSError:
                item['size'] = 0
                item['mtime'] = 0
                item['mode'] = ''
            item['dir'] = e.is_dir(follow_symlinks=False)
            item['link'] = e.is_symlink()
            entries.append(item)
    entries.sort(key=lambda x: (not x['dir'], x['name'].lower()))
    print(json.dumps({
        'ok': True,
        'path': path,
        'parent': os.path.dirname(path.rstrip('/')) or '/',
        'entries': entries,
    }))
except Exception as ex:
    print(json.dumps({'ok': False, 'error': str(ex), 'path': path}))
`;

/** 读文件。argv[1] = 路径，argv[2] = 最多读多少字节。 */
const READ_PY = `
import os, json, sys
path = os.path.expanduser(sys.argv[1])
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 262144
try:
    size = os.stat(path).st_size
    with open(path, 'rb') as handle:
        raw = handle.read(limit)
    if b'\\x00' in raw[:8192]:
        print(json.dumps({'ok': True, 'binary': True, 'size': size, 'path': path}))
    else:
        print(json.dumps({
            'ok': True,
            'binary': False,
            'size': size,
            'truncated': size > len(raw),
            'text': raw.decode('utf-8', 'replace'),
            'path': path,
        }))
except Exception as ex:
    print(json.dumps({'ok': False, 'error': str(ex), 'path': path}))
`;

/** 主机概况。 */
const INFO_PY = `
import os, json, socket, platform
try:
    user = os.environ.get('USER') or os.environ.get('LOGNAME') or ''
except Exception:
    user = ''
print(json.dumps({
    'ok': True,
    'hostname': socket.gethostname(),
    'user': user,
    'home': os.path.expanduser('~'),
    'os': platform.platform(),
    'python': platform.python_version(),
}))
`;

// ─────────────────────────────────────────────────────────── AI 对话

/**
 * DSH 桌面版自带一个本地模型网关（`wb2api` 进程），桌面应用把它挂在
 * `127.0.0.1:7863`，走 OpenAI 兼容协议；密钥就是 profile 配置里
 * `apiKeyEnv: WB_API_KEY` 指向的那把，存在 `~/.dsh/.credentials.yaml` 的 `refs:` 段。
 *
 * 实测（2026-10-10）：`POST /v1/chat/completions` 返回 200；带 `tools` 参数时
 * `finish_reason` 变成 `"tool_calls"` 并给出规范的 `tool_calls` 数组。
 * 所以插件可以自己跑「问模型 → 执行工具 → 结果塞回去再问」的循环，
 * 不必去猜 DSH 内部的会话 API。
 *
 * 想换模型或换网关，写 `~/.dsh/ssh-explorer/chat.json`：
 * `{ "model": "...", "baseURL": "...", "apiKey": "..." }`
 */
const CREDENTIALS_FILE = join(homedir(), ".dsh", ".credentials.yaml");
const CHAT_CONFIG_FILE = join(STORE_DIR, "chat.json");
const GATEWAY_FALLBACK = "http://localhost:7863/v1";
const CHAT_MODEL_FALLBACK = "cn:deepseek-v4.1-flash";
const CHAT_MAX_ROUNDS = 10;
const CHAT_MAX_OUTPUT = 6000;

/** 从 `.credentials.yaml` 的 `refs:` 段取一把密钥。 */
async function readCredentialRef(name) {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    const text = await readFile(CREDENTIALS_FILE, "utf8");
    const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(\\S+)[ \\t]*$`, "m").exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** 网关配置：`chat.json` 优先，否则用桌面版默认那套。 */
async function chatConfig() {
  let extra = {};
  if (existsSync(CHAT_CONFIG_FILE)) {
    try {
      extra = JSON.parse(await readFile(CHAT_CONFIG_FILE, "utf8"));
    } catch {
      extra = {};
    }
  }
  const explicit = typeof extra.apiKey === "string" && extra.apiKey.length > 0 ? extra.apiKey : null;
  const apiKey =
    explicit ??
    (await readCredentialRef("WB_API_KEY")) ??
    (await readCredentialRef("DEEPSEEK_API_KEY")) ??
    "";
  return {
    baseURL: String(extra.baseURL || GATEWAY_FALLBACK).replace(/\/+$/, ""),
    model: String(extra.model || CHAT_MODEL_FALLBACK),
    apiKey,
    source: explicit !== null ? "chat.json" : "credentials",
  };
}

/** 模型名白名单形状：网关用的是 `cn:xxx` 这种带冒号的名字。 */
const CHAT_MODEL_PATTERN = /^[A-Za-z0-9._:\-]{1,80}$/;

/**
 * 网关不可达时的兜底清单。
 * 2026-10-11 从 `GET 127.0.0.1:7863/v1/models` 实测拿到 19 个，按此写死。
 */
const CHAT_MODEL_FALLBACK_LIST = [
  "cn:auto",
  "cn:deepseek-v4.1-flash",
  "cn:deepseek-v4-flash",
  "cn:deepseek-v4-pro",
  "cn:glm-5.3",
  "cn:glm-5.3-flash",
  "cn:glm-5.2",
  "cn:glm-5.1",
  "cn:glm-5v-turbo",
  "cn:kimi-k3-1",
  "cn:kimi-k2.8-preview",
  "cn:kimi-k2.7",
  "cn:kimi-k2.6",
  "cn:hy4-preview",
  "cn:hy4-preview-f",
  "cn:hy3",
  "cn:hy3-x",
  "cn:minimax-m3",
  "cn:space-bunny",
];

/** 模型清单缓存：TTL 60 秒，免得每开一次面板就打一次网关。 */
let chatModelCache = { at: 0, list: [] };

/** 拉网关的模型清单；失败就退回内置清单。 */
async function listChatModels(config) {
  const now = Date.now();
  if (chatModelCache.list.length > 0 && now - chatModelCache.at < 60000) return chatModelCache.list;
  let list = [];
  try {
    const response = await fetch(`${config.baseURL}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const parsed = await response.json();
      const raw = Array.isArray(parsed?.data) ? parsed.data : [];
      list = raw
        .map((item) => String(item?.id ?? ""))
        .filter((id) => CHAT_MODEL_PATTERN.test(id));
    }
  } catch {
    list = [];
  }
  if (list.length === 0) list = CHAT_MODEL_FALLBACK_LIST.slice();
  chatModelCache = { at: now, list };
  return list;
}

/** DSH 各 profile 的目录，模型提供商就配在里面的 `cordis.patch.yml`。 */
const PROFILES_DIR = join(homedir(), ".dsh", "profiles");

/** 懒加载 `yaml`：先让 Node 自己解析，不行就从 profile 的 node_modules 里 require。 */
let yamlModule;
async function loadYaml() {
  if (yamlModule !== undefined) return yamlModule;
  try {
    yamlModule = await import("yaml");
    return yamlModule;
  } catch {
    yamlModule = null;
  }
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    if (existsSync(PROFILES_DIR)) {
      for (const dir of await readdir(PROFILES_DIR)) {
        const candidate = join(PROFILES_DIR, dir, "node_modules", "yaml");
        if (!existsSync(candidate)) continue;
        try {
          yamlModule = req(candidate);
          return yamlModule;
        } catch {
          /* 试下一个 profile */
        }
      }
    }
  } catch {
    yamlModule = null;
  }
  return yamlModule;
}

/**
 * 读 DSH 自己配置的模型提供商。
 *
 * 桌面版的「设置 → 模型」最终落在 `~/.dsh/profiles/<name>/cordis.patch.yml` 的
 * `llm-pi-ai.config.providers.<name>` 里，每条带 baseURL / apiKeyEnv / models[]。
 * 这里把它读出来，让对话面板的下拉框列的是**用户真正配过的**模型，
 * 而不是网关 `/v1/models` 吐出来的那一大坨。
 *
 * 读不到（没有 yaml 包 / 文件不存在 / 结构不对）就返回空数组，调用方自然退回网关清单。
 *
 * @returns {Promise<Array<{name:string, baseURL:string, apiKeyEnv:string, apiKey:string, models:Array<{id:string,name:string}>}>>}
 */
let providerCache = { at: 0, list: [] };
async function readConfiguredProviders() {
  const now = Date.now();
  if (providerCache.list.length > 0 && now - providerCache.at < 60000) return providerCache.list;
  const yaml = await loadYaml();
  if (yaml === null || typeof yaml.parse !== "function") return [];
  const found = [];
  try {
    if (!existsSync(PROFILES_DIR)) return [];
    for (const dir of await readdir(PROFILES_DIR)) {
      const file = join(PROFILES_DIR, dir, "cordis.patch.yml");
      if (!existsSync(file)) continue;
      const text = await readFile(file, "utf8");
      let doc;
      try {
        doc = yaml.parse(text, { logLevel: "silent" });
      } catch {
        try {
          doc = yaml.parse(text);
        } catch {
          continue;
        }
      }
      if (!Array.isArray(doc)) continue;
      for (const entry of doc) {
        const providers = entry?.config?.providers;
        if (providers === null || typeof providers !== "object" || Array.isArray(providers)) continue;
        for (const [providerName, raw] of Object.entries(providers)) {
          if (raw === null || typeof raw !== "object") continue;
          const baseURL = typeof raw.baseURL === "string" ? raw.baseURL.trim() : "";
          if (baseURL.length === 0) continue;
          const models = (Array.isArray(raw.models) ? raw.models : [])
            .map((item) => ({
              id: String(item?.id ?? ""),
              name: String(item?.name ?? item?.id ?? ""),
            }))
            .filter((item) => CHAT_MODEL_PATTERN.test(item.id));
          if (models.length === 0) continue;
          found.push({
            name: providerName,
            baseURL,
            apiKeyEnv: typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv : "",
            apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
            models,
          });
        }
      }
      if (found.length > 0) break;
    }
  } catch {
    return [];
  }
  providerCache = { at: now, list: found };
  return found;
}

/**
 * 定出这次对话真正要用的 { baseURL, model, apiKey }。
 *
 * 顺序：`chat.json` / 内置默认 → 客户端传上来的 model 覆盖 model 字段 →
 * 如果这个 model 命中某个**用户配置的** provider，就连 baseURL 与密钥一起换成它的。
 * 没命中（或那个 provider 取不到密钥）就维持原样，行为与加这个功能之前一致。
 */
async function resolveChatTarget(rawModel) {
  const config = await chatConfig();
  const wanted = String(rawModel ?? "");
  if (CHAT_MODEL_PATTERN.test(wanted)) config.model = wanted;
  for (const provider of await readConfiguredProviders()) {
    if (!provider.models.some((item) => item.id === config.model)) continue;
    const key =
      provider.apiKey.length > 0
        ? provider.apiKey
        : ((await readCredentialRef(provider.apiKeyEnv)) ?? "");
    if (key.length === 0) continue;
    config.baseURL = provider.baseURL.replace(/\/+$/, "");
    config.apiKey = key;
    config.provider = provider.name;
    break;
  }
  return config;
}

/**
 * GET /chat-models
 * 返回 { ok, models: [...], providers: [{ name, baseURL, models: [{id,name}] }], extra: [...], current, source }
 * `models` 是扁平清单（顺序 = 分组顺序 + 网关剩余），`providers` 给客户端画 optgroup。
 */
async function handleChatModels(req, res) {
  if (!methodAllowed(req, res, "GET")) return;
  const config = await chatConfig();
  const groups = [];
  const configured = new Set();
  for (const provider of await readConfiguredProviders()) {
    groups.push({ name: provider.name, baseURL: provider.baseURL, models: provider.models });
    for (const item of provider.models) configured.add(item.id);
  }
  const gateway = await listChatModels(config);
  const extra = gateway.filter((id) => !configured.has(id));
  const models = [];
  for (const group of groups) for (const item of group.models) models.push(item.id);
  for (const id of extra) models.push(id);
  if (!models.includes(config.model)) models.unshift(config.model);
  sendJson(res, 200, {
    ok: true,
    models,
    providers: groups,
    extra,
    current: config.model,
    source: config.source,
  });
}

/**
 * POST /chat-config
 * body: { model }
 * 把选中的模型落盘到 `~/.dsh/ssh-explorer/chat.json`（保留已有 baseURL / apiKey）。
 */
async function handleChatConfig(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const body = await readJsonBody(req);
  const model = String(body?.model ?? "");
  if (!CHAT_MODEL_PATTERN.test(model)) {
    return sendJson(res, 400, { ok: false, error: "model 不合法" });
  }
  let extra = {};
  if (existsSync(CHAT_CONFIG_FILE)) {
    try {
      extra = JSON.parse(await readFile(CHAT_CONFIG_FILE, "utf8"));
    } catch {
      extra = {};
    }
  }
  if (extra === null || typeof extra !== "object" || Array.isArray(extra)) extra = {};
  extra.model = model;
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(CHAT_CONFIG_FILE, `${JSON.stringify(extra, null, 2)}\n`, "utf8");
  chatModelCache = { at: 0, list: [] };
  sendJson(res, 200, { ok: true, model, file: CHAT_CONFIG_FILE });
}

/** 交给模型的工具。只有四个，写代码够用了。 */
const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "ssh_exec",
      description: "在远程主机上执行一条 shell 命令，返回 stdout 与 stderr。远端是 Linux/bash，不要用交互式命令。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
          timeoutMs: { type: "number", description: "超时毫秒数，默认 25000，上限 120000" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ssh_list",
      description: "列出一个远程目录的内容（名称、大小、修改时间、是否目录）。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "远程路径，可以用 ~" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ssh_read",
      description: "读取一个远程文本文件的内容（上限 512KB，超出会被截断）。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "远程文件路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ssh_write",
      description: "把整段文本写入远程文件（自动建父目录，覆盖原内容）。改文件优先用它，不要用 heredoc 拼长文本。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "远程文件路径" },
          content: { type: "string", description: "要写入的完整文本内容" },
        },
        required: ["path", "content"],
      },
    },
  },
];

/** 把过长的输出截断，免得把上下文撑爆。 */
function clip(text, limit = CHAT_MAX_OUTPUT) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…（已截断，原长 ${value.length} 字符）`;
}

/** 执行一次模型请求的工具调用，返回给模型看的字符串。 */
async function runChatTool(connection, name, args) {
  const input = args && typeof args === "object" ? args : {};
  if (name === "ssh_exec") {
    const command = String(input.command ?? "");
    if (command.trim().length === 0) return "错误：command 不能为空";
    const raw = Number(input.timeoutMs);
    const timeout = Number.isFinite(raw) ? Math.min(Math.max(raw, 1000), 120000) : SSH_TIMEOUT_MS;
    const result = await sshExec(connection, command, timeout);
    const parts = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    if (!result.ok && result.message) parts.push(`[失败] ${result.message}`);
    if (parts.length === 0) parts.push(result.ok ? "（命令没有输出）" : "（命令失败且没有输出）");
    return clip(parts.join("\n"));
  }
  if (name === "ssh_list") {
    const target = String(input.path ?? "").trim() || "~";
    const result = await remotePython(connection, LIST_PY, [target]);
    if (!result.ok) return `错误：${result.error}`;
    const rows = result.entries.map(
      (entry) => `${entry.dir ? "d" : "-"} ${String(entry.size).padStart(10)} ${entry.mtime || ""} ${entry.name}`,
    );
    return clip(`${result.path}（${result.entries.length} 项）\n${rows.join("\n")}`);
  }
  if (name === "ssh_read") {
    const target = String(input.path ?? "").trim();
    if (target.length === 0) return "错误：path 不能为空";
    const result = await remotePython(connection, READ_PY, [target]);
    if (!result.ok) return `错误：${result.error}`;
    return clip(result.text ?? "");
  }
  if (name === "ssh_write") {
    const target = String(input.path ?? "").trim();
    if (target.length === 0) return "错误：path 不能为空";
    const content = String(input.content ?? "");
    const result = await writeRemoteFile(connection, target, content);
    if (!result.ok) return `错误：${result.error}`;
    const backupNote = result.backup ? `，原文件已备份到 ${result.backup}` : "";
    return `已写入 ${result.path}（${result.bytes} 字节${backupNote}）`;
  }
  return `错误：没有名为 ${name} 的工具`;
}

/** 系统提示词：告诉模型它在哪、能用什么。 */
function chatSystemPrompt(connection, currentPath) {
  const label = connection.label || connection.host;
  const login = connection.user ? `${connection.user}@${connection.host}` : connection.host;
  const lines = [
    "你是嵌在 DSH「远程资源管理器」插件里的编码助手。你自己运行在用户的 Windows 机器上，",
    `但可以通过 SSH 操作远端 Linux 主机「${label}」（${login}）。`,
  ];
  if (currentPath) lines.push(`用户当前在界面上看的目录是 ${currentPath}。`);
  lines.push(
    "",
    "你的任务是帮用户在这台远程主机上写代码、改代码、跑命令、排查问题。",
    "可用工具：ssh_exec（跑命令）、ssh_list（列目录）、ssh_read（读文件）、ssh_write（整段写文件）。",
    "",
    "工作方式：",
    "- 改文件优先用 ssh_write（整段覆盖，不怕引号和换行）；改完用 ssh_exec 跑一遍验证。",
    "- 不要用 heredoc 拼长文本，也不要用交互式命令（vim / top / less 会挂住）。",
    "- 先看清现状再动手：不确定就用 ssh_list / ssh_read 看一眼。",
    "- 回答用中文，短、直给：先说做了什么，再说关键结果。不要复述工具输出。",
    "- 不要说「我无法访问」——你有 SSH，能直接操作。",
  );
  return lines.join("\n");
}

/** 打一次本地网关。 */
async function gatewayChat(config, messages) {
  const body = { model: config.model, messages, max_tokens: 8000, stream: false, tools: CHAT_TOOLS, tool_choice: "auto" };
  let response;
  try {
    response = await fetch(`${config.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    // 网关没起来时 fetch 会直接 reject；带上 baseURL，不然用户只看到一句 fetch failed 没法排查。
    return {
      ok: false,
      error: `连不上模型网关 ${config.baseURL}（模型 ${config.model}）：${String(err?.message ?? err)}`,
    };
  }
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, error: `模型网关返回 HTTP ${response.status}：${text.slice(0, 300)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `模型网关返回的不是 JSON：${text.slice(0, 300)}` };
  }
  const message = parsed?.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    return { ok: false, error: "模型网关返回里没有 choices[0].message" };
  }
  return { ok: true, message, usage: parsed.usage };
}

/**
 * 流式版网关调用：解析 SSE，把每一片增量交给 onEvent，最后返回拼好的完整结果。
 *
 * 两处必须按分片累积、不能逐片解析：
 * - `delta.reasoning_content` 是思考过程，逐字符到达；
 * - `delta.tool_calls[].function.arguments` 是**逐字符**到达的 JSON 文本片段，
 *   要按 `index` 拼成完整串再 JSON.parse。
 *
 * @returns { ok, content, reasoning, toolCalls, usage } 或 { ok:false, error }
 */
async function gatewayChatStream(config, messages, onEvent, signal) {
  const body = {
    model: config.model,
    messages,
    max_tokens: 8000,
    stream: true,
    tools: CHAT_TOOLS,
    tool_choice: "auto",
  };
  let response;
  try {
    response = await fetch(`${config.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(180000),
    });
  } catch (err) {
    return {
      ok: false,
      error: `连不上模型网关 ${config.baseURL}（模型 ${config.model}）：${String(err?.message ?? err)}`,
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, error: `模型网关返回 HTTP ${response.status}：${text.slice(0, 300)}` };
  }
  if (!response.body) {
    return { ok: false, error: "模型网关没有返回响应体，读不了流" };
  }

  let content = "";
  let reasoning = "";
  let usage = null;
  const callSlots = new Map();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut).replace(/\r$/, "");
      buffer = buffer.slice(cut + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload.length === 0 || payload === "[DONE]") continue;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (obj && obj.usage) usage = obj.usage;
      const delta = obj?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        reasoning += delta.reasoning_content;
        onEvent?.({ type: "thinking", text: delta.reasoning_content });
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        onEvent?.({ type: "reply", text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const piece of delta.tool_calls) {
          const index = Number.isInteger(piece?.index) ? piece.index : 0;
          let slot = callSlots.get(index);
          if (!slot) {
            slot = { id: "", name: "", args: "" };
            callSlots.set(index, slot);
          }
          if (piece?.id) slot.id = String(piece.id);
          if (piece?.function?.name) slot.name = String(piece.function.name);
          if (typeof piece?.function?.arguments === "string") slot.args += piece.function.arguments;
        }
      }
    }
  }

  const toolCalls = [...callSlots.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, slot]) => ({
      index,
      id: slot.id || `call_${index}`,
      type: "function",
      function: { name: slot.name, arguments: slot.args },
    }))
    .filter((call) => call.function.name.length > 0);

  return { ok: true, content, reasoning, toolCalls, usage };
}

/**
 * 把一轮对话以 SSE 推给客户端。
 * 事件：round / thinking / thinking-done / reply / tool-start / tool / done / error
 */
async function chatStream(res, config, messages, connection) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  let clientGone = false;
  res.on?.("close", () => {
    clientGone = true;
  });

  const sse = (type, payload) => {
    if (clientGone || res.writableEnded) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const steps = [];
  let reply = "";
  let reasoningAll = "";
  let usage = null;

  try {
    for (let round = 0; round < CHAT_MAX_ROUNDS; round += 1) {
      sse("round", { round: round + 1, max: CHAT_MAX_ROUNDS });
      const result = await gatewayChatStream(config, messages, (event) => {
        if (event.type === "thinking") sse("thinking", { text: event.text });
        else if (event.type === "reply") sse("reply", { text: event.text });
      });
      if (!result.ok) {
        sse("error", { error: result.error, steps, reply });
        return;
      }
      if (result.usage) usage = result.usage;
      reasoningAll += result.reasoning;
      // 这一轮的思考结束。带上完整文本，客户端折叠后仍能展开看全文。
      if (result.reasoning.length > 0) sse("thinking-done", { text: result.reasoning });

      const calls = result.toolCalls;
      messages.push({
        role: "assistant",
        content: result.content,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });

      if (calls.length === 0) {
        reply = result.content.trim();
        break;
      }

      for (const call of calls) {
        const toolName = call.function.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(call.function.arguments || "{}");
        } catch {
          toolArgs = {};
        }
        sse("tool-start", { name: toolName, args: toolArgs });
        let output;
        try {
          output = await runChatTool(connection, toolName, toolArgs);
        } catch (error) {
          output = `工具执行出错：${error instanceof Error ? error.message : String(error)}`;
        }
        const shown = clip(output, 1200);
        steps.push({ name: toolName, args: toolArgs, output: shown });
        sse("tool", { name: toolName, args: toolArgs, output: shown });
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    }

    if (reply.length === 0) {
      reply = "（工具调用到了轮次上限，模型还没给出最终回答。可以把要求拆小一点再问。）";
    }
    sse("done", { ok: true, reply, steps, model: config.model, reasoning: reasoningAll, usage });
  } catch (error) {
    sse("error", { error: error instanceof Error ? error.message : String(error), steps, reply });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * POST /chat
 * body: { connectionId, messages: [{ role, content }], path? }
 * 返回 { ok, reply, steps: [{ name, args, output }], model }
 */
/** 装载时由 cordis 传进来的 `config`（见 apply）。目前只认 `chat: false` 这一个开关。 */
let pluginConfig = {};

async function handleChat(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  if (pluginConfig && pluginConfig.chat === false) {
    return sendJson(res, 403, { ok: false, error: "AI 对话已在插件配置里关闭（config.chat = false）" });
  }
  const body = await readJsonBody(req);
  const connectionId = String(body?.connectionId ?? "");
  if (connectionId.length === 0) return sendJson(res, 400, { ok: false, error: "缺少 connectionId" });

  const connection = await resolveConnection(connectionId);
  if (!connection) return sendJson(res, 404, { ok: false, error: "找不到该连接" });

  const incoming = Array.isArray(body?.messages) ? body.messages : [];
  const history = incoming
    .filter(
      (item) =>
        item && typeof item.content === "string" && (item.role === "user" || item.role === "assistant"),
    )
    .slice(-24)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 40000) }));
  if (history.length === 0) return sendJson(res, 400, { ok: false, error: "messages 不能为空" });

  // 客户端选的模型优先于 chat.json / 默认值；命中用户配置的 provider 时连 baseURL 与密钥一起换。
  const config = await resolveChatTarget(body?.model);
  if (config.apiKey.length === 0) {
    return sendJson(res, 500, {
      ok: false,
      error: "找不到模型密钥：~/.dsh/.credentials.yaml 里没有 WB_API_KEY，可手动写 ~/.dsh/ssh-explorer/chat.json",
    });
  }

  const messages = [
    { role: "system", content: chatSystemPrompt(connection, String(body?.path ?? "")) },
  ].concat(history);

  // 流式：把思考、正文、工具调用一片片推回去，客户端能实时看到过程。
  if (body?.stream === true) {
    await chatStream(res, config, messages, connection);
    return;
  }

  const steps = [];
  let reply = "";

  for (let round = 0; round < CHAT_MAX_ROUNDS; round += 1) {
    const response = await gatewayChat(config, messages);
    if (!response.ok) {
      return sendJson(res, 502, { ok: false, error: response.error, steps, reply });
    }
    const message = response.message;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    messages.push({
      role: "assistant",
      content: typeof message.content === "string" ? message.content : "",
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    });
    if (calls.length === 0) {
      reply = String(message.content ?? "").trim();
      break;
    }
    for (const call of calls) {
      const toolName = String(call?.function?.name ?? "");
      let toolArgs = {};
      try {
        toolArgs = JSON.parse(call?.function?.arguments ?? "{}");
      } catch {
        toolArgs = {};
      }
      let output;
      try {
        output = await runChatTool(connection, toolName, toolArgs);
      } catch (error) {
        output = `工具执行出错：${error instanceof Error ? error.message : String(error)}`;
      }
      steps.push({ name: toolName, args: toolArgs, output: clip(output, 1200) });
      messages.push({ role: "tool", tool_call_id: call?.id ?? "", content: output });
    }
  }

  if (reply.length === 0) reply = "（工具调用到了轮次上限，模型还没给出最终回答。可以把要求拆小一点再问。）";
  sendJson(res, 200, { ok: true, reply, steps, model: config.model });
}

// ─────────────────────────────────────────────────────────── HTTP 辅助

// ─────────────────────────────────────────────────────────── 远端终端

/** 终端命令包装脚本里的标记，靠它把退出码和最终 cwd 从 stdout 里摘出来。 */
const EXEC_MARK = "__DSH_RE_EXEC_9F3A__";

/**
 * 把用户输入的一行命令包成一段脚本：
 *   cd 到会话 cwd → 挂 EXIT trap 打标记 → 执行命令
 *
 * 用 trap 而不是在命令后面追加 printf，是为了让 `exit 3`、`exec` 这类命令
 * 也能拿到退出码和最终 cwd。标记里的 cwd 让客户端的 `cd` 能真的生效。
 */
function wrapTerminalCommand(command, cwd) {
  const cdLine =
    cwd && cwd.length > 0
      ? `cd ${shq(cwd)} 2>/dev/null || cd "$HOME" 2>/dev/null || true`
      : `cd "$HOME" 2>/dev/null || true`;
  return [
    cdLine,
    `__dsh_mark() { printf '\\n\\001${EXEC_MARK}\\001%s\\001%s\\001\\n' "$1" "$PWD"; }`,
    `trap '__dsh_rc=$?; __dsh_mark "$__dsh_rc"' EXIT`,
    command,
  ].join("\n");
}

/** 从 stdout 里剥掉标记，返回 { output, code, cwd }。没有标记说明脚本没跑到 trap。 */
function parseTerminalOutput(stdout, fallbackCwd) {
  const needle = `\u0001${EXEC_MARK}\u0001`;
  const at = stdout.lastIndexOf(needle);
  if (at < 0) return { output: stdout, code: null, cwd: fallbackCwd };
  const output = stdout.slice(0, at).replace(/\n$/, "");
  const parts = stdout.slice(at + needle.length).split("\u0001");
  const code = Number.parseInt(parts[0], 10);
  const cwd = parts.length > 1 && parts[1].length > 0 ? parts[1] : fallbackCwd;
  return { output, code: Number.isInteger(code) ? code : null, cwd };
}

/**
 * POST /exec
 * body: { connectionId, command, cwd?, timeoutMs? }
 * 返回 { ok, stdout, stderr, code, cwd, durationMs }
 *
 * 不是 PTY —— 每条命令一次 ssh。交互式程序（vim/top/ssh 里再 ssh）跑不了，
 * 但 `cd` 靠会话 cwd 记忆、退出码靠 EXIT trap，日常操作够用。
 */
async function handleExec(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const body = await readJsonBody(req);
  const connectionId = String(body?.connectionId ?? "");
  if (connectionId.length === 0) return sendJson(res, 400, { ok: false, error: "缺少 connectionId" });

  const command = String(body?.command ?? "");
  if (command.trim().length === 0) return sendJson(res, 400, { ok: false, error: "命令不能为空" });
  if (command.length > 8000) return sendJson(res, 400, { ok: false, error: "命令太长（上限 8000 字符）" });

  const connection = await resolveConnection(connectionId);
  if (!connection) return sendJson(res, 404, { ok: false, error: "找不到该连接" });

  const cwd = String(body?.cwd ?? "");
  const asked = Number(body?.timeoutMs);
  const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 3600000) : 120000;

  const started = Date.now();
  const result = await sshExec(connection, wrapTerminalCommand(command, cwd), timeoutMs);
  const parsed = parseTerminalOutput(result.stdout, cwd);
  const durationMs = Date.now() - started;

  // 超时是终端最常见的「卡住」，单独给一句能看懂的话。
  if (!result.ok && /超时/.test(result.message)) {
    return sendJson(res, 200, {
      ok: false,
      stdout: parsed.output,
      stderr: result.stderr,
      code: parsed.code,
      cwd,
      durationMs,
      error: `命令超过 ${Math.round(timeoutMs / 1000)} 秒还没结束，已中断`,
    });
  }
  // trap 没跑到（比如连不上）：这时没有退出码，只能报 ssh 自己的错误。
  if (!result.ok && parsed.code === null) {
    return sendJson(res, 200, {
      ok: false,
      stdout: parsed.output,
      stderr: result.stderr,
      code: null,
      cwd,
      durationMs,
      error: result.message || "ssh 执行失败",
    });
  }

  sendJson(res, 200, {
    ok: true,
    stdout: parsed.output,
    stderr: result.stderr,
    code: parsed.code ?? 0,
    cwd: parsed.cwd,
    durationMs,
  });
}

/** 写 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

/** 读请求体（上限 1MB）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** 从请求 URL 里取查询参数。 */
function queryOf(req) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  return url.searchParams;
}

/**
 * 同源栅栏。
 *
 * profile 里有一段托管块把 webserver 绑到了 `host: '0.0.0.0'`（为 `dsh-remote-web-ui`
 * 的局域网访问服务），所以这些路由在局域网里是可达的。它们能读远端主机的任意文件，
 * 因此拒绝跨站发起：浏览器带的 `Sec-Fetch-Site: cross-site` 一律拒；带了 `Origin`
 * 就必须和 `Host` 同 authority。非浏览器客户端（不带这两个头）不受影响。
 */
function originAllowed(req) {
  const headers = req.headers ?? {};
  if (headers["sec-fetch-site"] === "cross-site") return false;
  const origin = headers.origin;
  if (origin === undefined || origin === "") return true;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}

/** 只允许指定方法。 */
function methodAllowed(req, res, method) {
  if ((req.method ?? "GET").toUpperCase() === method) return true;
  sendJson(res, 405, { ok: false, error: `只支持 ${method}` });
  return false;
}

// ─────────────────────────────────────────────────────────── 路由实现

/** GET /connections —— 全部连接（ssh config + 用户自建）+ 已删除名单。 */
async function handleConnectionsGet(req, res) {
  if (!methodAllowed(req, res, "GET")) return;
  const connections = await mergedConnections();
  const hidden = await loadHidden();
  sendJson(res, 200, {
    ok: true,
    connections,
    hidden: Object.values(hidden).sort((a, b) => (Number(b.hiddenAt) || 0) - (Number(a.hiddenAt) || 0)),
    sshConfigPath: SSH_CONFIG_PATH,
    storeFile: STORE_FILE,
    sshAvailable: sshBinary() !== null,
    chatEnabled: !(pluginConfig && pluginConfig.chat === false),
  });
}

/** POST /connections —— 新增 / 更新 / 删除自建连接，或设置某条连接的口令。 */
async function handleConnectionsPost(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  const stored = await loadStoredConnections();
  const action = String(body.action ?? "");

  if (action === "save") {
    const connection = body.connection ?? {};
    const host = String(connection.host ?? "").trim();
    if (host.length === 0) {
      sendJson(res, 400, { ok: false, error: "host 不能为空" });
      return;
    }
    // Date.now() 只有毫秒精度，连续两次保存可能撞上同一个 id 而互相覆盖，
    // 所以再掺一段随机后缀。
    const id =
      String(connection.id ?? "").trim() ||
      `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      name: String(connection.name ?? "").trim() || host,
      host,
      port: Number(connection.port) || undefined,
      user: String(connection.user ?? "").trim() || undefined,
      identityFile: String(connection.identityFile ?? "").trim() || undefined,
      authType: AUTH_TYPES.has(connection.authType) ? connection.authType : "auto",
      source: "user",
    };
    const index = stored.findIndex((item) => item.id === id);
    if (index >= 0) stored[index] = record;
    else stored.push(record);
    await saveStoredConnections(stored);

    // 表单里同时带了口令就一并存起来（加密后进 secrets.json，不进连接定义）。
    let hasPassword = false;
    if (typeof connection.password === "string" && connection.password.length > 0) {
      const encrypted = await encryptSecret(connection.password);
      if (!encrypted.ok) {
        sendJson(res, 500, { ok: false, error: `连接已保存，但口令加密失败：${encrypted.message}` });
        return;
      }
      const secrets = await loadSecrets();
      secrets[id] = encrypted.value;
      await saveSecrets(secrets);
      forgetSecret(id);
      hasPassword = true;
    } else {
      hasPassword = typeof (await loadSecrets())[id] === "string";
    }
    sendJson(res, 200, { ok: true, connection: { ...record, hasPassword } });
    return;
  }

  if (action === "secret") {
    const id = String(body.id ?? "").trim();
    if (id.length === 0) {
      sendJson(res, 400, { ok: false, error: "id 不能为空" });
      return;
    }
    const secrets = await loadSecrets();
    if (body.clear === true) {
      delete secrets[id];
      await saveSecrets(secrets);
      forgetSecret(id);
      sendJson(res, 200, { ok: true, hasPassword: false });
      return;
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length === 0) {
      sendJson(res, 400, { ok: false, error: "password 不能为空；要清除请传 clear: true" });
      return;
    }
    const encrypted = await encryptSecret(password);
    if (!encrypted.ok) {
      sendJson(res, 500, { ok: false, error: `口令加密失败：${encrypted.message}` });
      return;
    }
    secrets[id] = encrypted.value;
    await saveSecrets(secrets);
    forgetSecret(id);
    sendJson(res, 200, { ok: true, hasPassword: true });
    return;
  }

  if (action === "delete") {
    const id = String(body.id ?? "").trim();
    if (id.length === 0) {
      sendJson(res, 400, { ok: false, error: "id 不能为空" });
      return;
    }
    const target = (await mergedConnections()).find((item) => item.id === id) ?? null;
    const isStored = stored.some((item) => item.id === id);
    if (target === null && !isStored && !(id in (await loadHidden()))) {
      sendJson(res, 200, { ok: true, id, removed: false, hiddenOnly: false });
      return;
    }
    if (isStored) {
      await saveStoredConnections(stored.filter((item) => item.id !== id));
    }
    // 从 ~/.ssh/config 发现的主机不能真删（那是用户手写的文件），只从清单里隐藏。
    const hidden = await loadHidden();
    const hiddenOnly = !isStored;
    if (hiddenOnly) {
      hidden[id] = {
        id,
        name: target ? String(target.name ?? id) : id,
        host: target ? String(target.host ?? "") : "",
        hiddenAt: Date.now(),
      };
    } else {
      delete hidden[id];
    }
    await saveHidden(hidden);
    const secrets = await loadSecrets();
    if (id in secrets) {
      delete secrets[id];
      await saveSecrets(secrets);
    }
    forgetSecret(id);
    sendJson(res, 200, { ok: true, id, removed: true, hiddenOnly });
    return;
  }

  if (action === "restore") {
    const id = String(body.id ?? "").trim();
    if (id.length === 0) {
      sendJson(res, 400, { ok: false, error: "id 不能为空" });
      return;
    }
    const hidden = await loadHidden();
    if (id in hidden) {
      delete hidden[id];
      await saveHidden(hidden);
    }
    sendJson(res, 200, { ok: true, id });
    return;
  }

  sendJson(res, 400, { ok: false, error: `未知 action：${action}` });
}

/** GET /info?connection=<id> —— 主机概况。 */
async function handleInfo(req, res) {
  if (!methodAllowed(req, res, "GET")) return;
  const connection = await resolveConnection(queryOf(req).get("connection") ?? "");
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const result = await remotePython(toSshTarget(connection), INFO_PY);
  sendJson(res, result.ok ? 200 : 502, result);
}

/** GET /list?connection=<id>&path=<dir> —— 列目录。 */
async function handleList(req, res) {
  if (!methodAllowed(req, res, "GET")) return;
  const params = queryOf(req);
  const connection = await resolveConnection(params.get("connection") ?? "");
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const path = params.get("path") ?? "";
  const result = await remotePython(toSshTarget(connection), LIST_PY, [path]);
  sendJson(res, result.ok ? 200 : 502, result);
}

/** GET /read?connection=<id>&path=<file> —— 读文件。 */
async function handleRead(req, res) {
  if (!methodAllowed(req, res, "GET")) return;
  const params = queryOf(req);
  const connection = await resolveConnection(params.get("connection") ?? "");
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const path = params.get("path") ?? "";
  if (path.length === 0) {
    sendJson(res, 400, { ok: false, error: "path 不能为空" });
    return;
  }
  const result = await remotePython(toSshTarget(connection), READ_PY, [path, String(MAX_READ_BYTES)]);
  sendJson(res, result.ok ? 200 : 502, result);
}

/**
 * POST /write —— 保存远程文本文件。
 *
 * body: `{ connection | connectionId, path, content }`，`content` 必须是字符串。
 * 覆盖前会留 `<名字>.re-bak` 备份，写入是原子替换。
 */
async function handleWrite(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  const connection = await resolveConnection(String(body.connection ?? body.connectionId ?? ""));
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const path = String(body.path ?? "").trim();
  if (path.length === 0) {
    sendJson(res, 400, { ok: false, error: "path 不能为空" });
    return;
  }
  if (typeof body.content !== "string") {
    sendJson(res, 400, { ok: false, error: "content 必须是字符串" });
    return;
  }
  const result = await writeRemoteFile(toSshTarget(connection), path, body.content);
  sendJson(res, result.ok ? 200 : 502, result);
}

/** GET /ping?connection=<id> —— 连通性。 */
async function handlePing(req, res) {
  if (!methodAllowed(req, res, "GET")) return;
  const connection = await resolveConnection(queryOf(req).get("connection") ?? "");
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const started = Date.now();
  const result = await sshExec(toSshTarget(connection), "echo REMOTE_RE_EXPLORER_OK", 15000);
  sendJson(res, 200, {
    ok: result.ok && result.stdout.includes("REMOTE_RE_EXPLORER_OK"),
    elapsedMs: Date.now() - started,
    message: result.ok ? "" : result.message,
  });
}

// ─────────────────────────────────────────────────────────── 传输路由

/** GET /locals —— 本机的落点目录（桌面 / 下载），面板用来显示「保存到桌面」。 */
async function handleLocals(req, res) {
  if (!methodAllowed(req, res, "GET")) return;
  const dirs = await localDirs();
  sendJson(res, 200, { ok: true, ...dirs });
}

/** POST /pull —— 远端路径（文件或目录）落到本机，默认桌面。 */
async function handlePull(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  const connection = await resolveConnection(String(body.connection ?? "").trim());
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const paths = Array.isArray(body.paths)
    ? body.paths.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
    : [];
  if (paths.length === 0) {
    sendJson(res, 400, { ok: false, error: "没有要下载的路径" });
    return;
  }
  const target = await resolvePullTarget(body.target);
  if (!target.ok) {
    sendJson(res, 400, { ok: false, error: target.message });
    return;
  }
  const job = createJob("download", paths.length === 1 ? posixBasename(paths[0]) : `${paths.length} 项`);
  job.target = target.dir;
  void runPullJob(job, toSshTarget(connection), paths, target.dir, body.overwrite === true);
  sendJson(res, 200, { ok: true, job: jobSnapshot(job), target: target.dir });
}

/**
 * POST /push —— 本机路径（文件或目录）推到远端目录。
 *
 * 传绝对路径而不是浏览器里的 File 对象：宿主自己能读、能递归，
 * 目录一次 tar 就搬完，比在浏览器里逐个文件流式上传快得多。
 */
async function handlePush(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  const connection = await resolveConnection(String(body.connection ?? "").trim());
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const dir = String(body.dir ?? "").trim();
  if (!dir.startsWith("/")) {
    sendJson(res, 400, { ok: false, error: "dir 必须是远端绝对路径" });
    return;
  }
  const paths = Array.isArray(body.paths)
    ? body.paths.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0 && isAbsolute(item))
    : [];
  if (paths.length === 0) {
    sendJson(res, 400, { ok: false, error: "没有可用的本机路径" });
    return;
  }
  const missing = paths.filter((item) => !existsSync(item));
  if (missing.length > 0) {
    sendJson(res, 400, { ok: false, error: `本机路径不存在：${missing[0]}` });
    return;
  }
  const job = createJob("upload", paths.length === 1 ? basename(paths[0]) : `${paths.length} 项`);
  job.target = dir;
  void runPushJob(job, toSshTarget(connection), dir, paths, body.overwrite === true);
  sendJson(res, 200, { ok: true, job: jobSnapshot(job), target: dir });
}

/**
 * POST /upload?connection&dir&relpath&mtime —— 浏览器里的文件字节直接推到远端。
 *
 * 宿主拿不到本机路径时（非 Electron 外壳、或浏览器不给路径）走这条兜底：
 * 请求体就是文件内容，边收边写给远端，不落临时文件。
 */
async function handleUpload(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const params = queryOf(req);
  const connection = await resolveConnection(params.get("connection") ?? "");
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const dir = String(params.get("dir") ?? "").trim();
  if (!dir.startsWith("/")) {
    sendJson(res, 400, { ok: false, error: "dir 必须是远端绝对路径" });
    return;
  }
  const relative = safeRelativePath(params.get("relpath") ?? "");
  if (relative === null) {
    sendJson(res, 400, { ok: false, error: "relpath 不合法" });
    return;
  }
  const mtimeMs = Number(params.get("mtime") ?? 0);
  const overwrite = params.get("overwrite") === "1";
  const target = posixJoin(dir, relative);
  let handle;
  try {
    handle = await spawnSsh(
      toSshTarget(connection),
      remoteUploadCommand(target, mtimeMs, overwrite),
      TRANSFER_TIMEOUT_MS,
      true,
    );
  } catch (error) {
    sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
    return;
  }
  const { child, done } = handle;
  req.pipe(child.stdin);
  req.on("error", () => {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  });
  const result = await done;
  const parsed = parseJsonLine(result);
  if (parsed === null) {
    sendJson(res, 502, { ok: false, error: result.stderr || `ssh 退出码 ${result.code}` });
    return;
  }
  sendJson(res, parsed.ok === true ? 200 : 409, parsed);
}

/** GET|POST /job —— 取任务进度；POST {id, cancel:true} 取消。 */
async function handleJob(req, res) {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "POST") {
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
      return;
    }
    const job = JOBS.get(String(body.id ?? ""));
    if (job === undefined) {
      sendJson(res, 404, { ok: false, error: "没有这个任务" });
      return;
    }
    if (body.cancel === true) {
      job.cancelRequested = true;
      for (const child of job.children) {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
      }
      job.updatedAt = Date.now();
    }
    sendJson(res, 200, { ok: true, job: jobSnapshot(job) });
    return;
  }
  const job = JOBS.get(queryOf(req).get("id") ?? "");
  if (job === undefined) {
    sendJson(res, 404, { ok: false, error: "没有这个任务" });
    return;
  }
  sendJson(res, 200, { ok: true, job: jobSnapshot(job) });
}

/** POST /reveal —— 在本机资源管理器里选中刚落地的文件/文件夹。 */
async function handleReveal(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  const target = String(body.path ?? "").trim();
  if (target.length === 0) {
    sendJson(res, 400, { ok: false, error: "path 不能为空" });
    return;
  }
  if (process.platform !== "win32") {
    sendJson(res, 400, { ok: false, error: "只有 Windows 支持在资源管理器里定位" });
    return;
  }
  if (!existsSync(target)) {
    sendJson(res, 404, { ok: false, error: "这个路径已经不存在了" });
    return;
  }
  try {
    const child = spawn("explorer.exe", [`/select,${target}`], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
}

/**
 * 删除远端文件/目录用的 Python。
 *
 * - 只接受绝对路径，且**拒绝根目录与家目录本身**（手滑一次就没了）；
 * - 目录递归删、符号链接只删链接本身（不跟进目标）；
 * - 目标本来就不存在也算成功（幂等），方便「多选里有已被别人删掉的」这种情况。
 */
const DELETE_PY = `
import json, os, pathlib, shutil, sys
raw = sys.argv[1]
path = os.path.abspath(os.path.expanduser(raw))
home = os.path.abspath(os.path.expanduser('~'))
trimmed = path.rstrip(os.sep) or os.sep
if trimmed == os.sep:
    print(json.dumps({'ok': False, 'error': '拒绝删除根目录'})); sys.exit(0)
if trimmed == home:
    print(json.dumps({'ok': False, 'error': '拒绝删除家目录本身'})); sys.exit(0)
target = pathlib.Path(path)
try:
    if not target.exists() and not target.is_symlink():
        print(json.dumps({'ok': True, 'path': path, 'kind': 'missing'})); sys.exit(0)
    if target.is_dir() and not target.is_symlink():
        shutil.rmtree(path)
        kind = 'dir'
    else:
        os.remove(path)
        kind = 'file'
    print(json.dumps({'ok': True, 'path': path, 'kind': kind}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error), 'path': path}))
`;

/**
 * POST /delete —— 删远端的一批文件/目录（多选后按 Del 或右键删除都走这里）。
 *
 * 逐条删、逐条报结果：一条失败不影响其它条，客户端按 `failed` 列出没删掉的。
 */
async function handleDelete(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  const connection = await resolveConnection(String(body.connection ?? "").trim());
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const paths = Array.isArray(body.paths)
    ? body.paths.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
    : [];
  if (paths.length === 0) {
    sendJson(res, 400, { ok: false, error: "没有要删除的路径" });
    return;
  }
  const removed = [];
  const failed = [];
  for (const target of paths) {
    if (!target.startsWith("/")) {
      failed.push({ path: target, error: "只支持远端绝对路径" });
      continue;
    }
    const result = await remotePython(connection, DELETE_PY, [target], DELETE_TIMEOUT_MS);
    if (result?.ok === true) {
      removed.push(target);
    } else {
      failed.push({ path: target, error: String(result?.error ?? "删除失败") });
    }
  }
  sendJson(res, 200, { ok: failed.length === 0, removed, failed });
}

/**
 * 在远端目录里新建空文件 / 空目录用的 Python。
 *
 * - 名字只允许单段：带 `/`、`\`、或者就是 `.` / `..` 的一律拒（不然能跳出目录）；
 * - 已存在同名的一律不覆盖（新建文件用 `open(..., 'x')`，连竞态都堵住）；
 * - 错误文案里带中文也没关系：JSON 默认把非 ASCII 转成 `\uXXXX`，不挑远端 locale。
 */
const CREATE_PY = `
import json, os, pathlib, sys

def fail(message):
    print(json.dumps({'ok': False, 'error': message}))
    sys.exit(0)

raw = sys.argv[1]
name = sys.argv[2]
kind = sys.argv[3]
directory = os.path.abspath(os.path.expanduser(raw))
if name in ('', '.', '..'):
    fail('名字不合法')
if '/' in name or '\\\\' in name:
    fail('名字里不能带路径分隔符')
base = pathlib.Path(directory)
if not base.is_dir():
    fail('目标目录不存在')
target = base / name
if target.exists() or target.is_symlink():
    fail('已存在同名文件或文件夹')
try:
    if kind == 'dir':
        target.mkdir()
        resolved = 'dir'
    else:
        with open(str(target), 'x'):
            pass
        resolved = 'file'
    print(json.dumps({'ok': True, 'path': str(target), 'kind': resolved}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
`;

/**
 * 重命名远端文件 / 目录用的 Python。
 *
 * 只改名字（`os.rename` 在同一父目录内），所以拖动/移动的语义不会混进来；
 * 根目录、家目录本身、以及带分隔符的新名字都拒。
 */
const RENAME_PY = `
import json, os, pathlib, sys

def fail(message):
    print(json.dumps({'ok': False, 'error': message}))
    sys.exit(0)

raw = sys.argv[1]
name = sys.argv[2]
path = os.path.abspath(os.path.expanduser(raw))
home = os.path.abspath(os.path.expanduser('~'))
trimmed = path.rstrip(os.sep) or os.sep
if trimmed == os.sep:
    fail('拒绝重命名根目录')
if trimmed == home:
    fail('拒绝重命名家目录本身')
if name in ('', '.', '..'):
    fail('名字不合法')
if '/' in name or '\\\\' in name:
    fail('名字里不能带路径分隔符')
source = pathlib.Path(path)
if not source.exists() and not source.is_symlink():
    fail('要重命名的东西已经不在了')
target = source.parent / name
if str(target) == str(source):
    print(json.dumps({'ok': True, 'path': str(source), 'unchanged': True}))
    sys.exit(0)
if target.exists() or target.is_symlink():
    fail('已存在同名文件或文件夹')
try:
    os.rename(path, str(target))
    print(json.dumps({'ok': True, 'path': str(target), 'from': path}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
`;

/** 从 body 里取一个单段名字，非法就返回 null。 */
function singleSegmentName(value) {
  const name = String(value ?? "").trim();
  if (name.length === 0 || name === "." || name === "..") return null;
  if (name.includes("/") || name.includes("\\")) return null;
  return name;
}

/**
 * POST /create —— 在远端目录里新建空文件或空文件夹。
 *
 * body：`{connection, dir, name, kind}`，kind 省略时按文件处理。
 */
async function handleCreate(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  const connection = await resolveConnection(String(body.connection ?? "").trim());
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const dir = String(body.dir ?? "").trim();
  if (!dir.startsWith("/")) {
    sendJson(res, 400, { ok: false, error: "dir 必须是远端绝对路径" });
    return;
  }
  const name = singleSegmentName(body.name);
  if (name === null) {
    sendJson(res, 400, { ok: false, error: "名字不合法（不能为空、不能带路径分隔符）" });
    return;
  }
  const kind = String(body.kind ?? "file") === "dir" ? "dir" : "file";
  const result = await remotePython(connection, CREATE_PY, [dir, name, kind], MUTATE_TIMEOUT_MS);
  if (result?.ok === true) {
    sendJson(res, 200, { ok: true, path: String(result.path ?? ""), kind: String(result.kind ?? kind) });
    return;
  }
  const message = String(result?.error ?? "新建失败");
  sendJson(res, message.includes("已存在") ? 409 : 400, { ok: false, error: message });
}

/**
 * POST /rename —— 就地重命名（同目录改名，不跨目录移动）。
 *
 * body：`{connection, path, name}`。
 */
async function handleRename(req, res) {
  if (!methodAllowed(req, res, "POST")) return;
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  const connection = await resolveConnection(String(body.connection ?? "").trim());
  if (connection === null) {
    sendJson(res, 404, { ok: false, error: "找不到该连接" });
    return;
  }
  const target = String(body.path ?? "").trim();
  if (!target.startsWith("/")) {
    sendJson(res, 400, { ok: false, error: "只支持远端绝对路径" });
    return;
  }
  const name = singleSegmentName(body.name);
  if (name === null) {
    sendJson(res, 400, { ok: false, error: "名字不合法（不能为空、不能带路径分隔符）" });
    return;
  }
  const result = await remotePython(connection, RENAME_PY, [target, name], MUTATE_TIMEOUT_MS);
  if (result?.ok === true) {
    sendJson(res, 200, {
      ok: true,
      path: String(result.path ?? ""),
      from: String(result.from ?? target),
      unchanged: result.unchanged === true,
    });
    return;
  }
  const message = String(result?.error ?? "重命名失败");
  sendJson(res, message.includes("已存在") ? 409 : 400, { ok: false, error: message });
}

/** 路由表。 */
const ROUTES = [
  { path: `${ROUTE_PREFIX}/connections`, handler: (req, res) => (req.method ?? "GET").toUpperCase() === "POST" ? handleConnectionsPost(req, res) : handleConnectionsGet(req, res) },
  { path: `${ROUTE_PREFIX}/info`, handler: handleInfo },
  { path: `${ROUTE_PREFIX}/list`, handler: handleList },
  { path: `${ROUTE_PREFIX}/read`, handler: handleRead },
  { path: `${ROUTE_PREFIX}/write`, handler: handleWrite },
  { path: `${ROUTE_PREFIX}/ping`, handler: handlePing },
  { path: `${ROUTE_PREFIX}/chat`, handler: handleChat },
  { path: `${ROUTE_PREFIX}/chat-models`, handler: handleChatModels },
  { path: `${ROUTE_PREFIX}/chat-config`, handler: handleChatConfig },
  { path: `${ROUTE_PREFIX}/exec`, handler: handleExec },
  { path: `${ROUTE_PREFIX}/locals`, handler: handleLocals },
  { path: `${ROUTE_PREFIX}/pull`, handler: handlePull },
  { path: `${ROUTE_PREFIX}/push`, handler: handlePush },
  { path: `${ROUTE_PREFIX}/upload`, handler: handleUpload },
  { path: `${ROUTE_PREFIX}/job`, handler: handleJob },
  { path: `${ROUTE_PREFIX}/reveal`, handler: handleReveal },
  { path: `${ROUTE_PREFIX}/delete`, handler: handleDelete },
  { path: `${ROUTE_PREFIX}/create`, handler: handleCreate },
  { path: `${ROUTE_PREFIX}/rename`, handler: handleRename },
];

/**
 * Cordis 入口。
 * @param ctx - 插件上下文，需要能取到 `webServer` 服务。
 */
export function apply(ctx, config) {
  pluginConfig = config && typeof config === "object" ? config : {};
  // 从 dsh-remote-explorer 改名过来：把旧状态目录（连接 + 口令）整体搬过来，
  // 这样老用户升级后不用重新填连接、也不用重设口令。
  migrateLegacyStore();
  const log = ctx.logger ?? console;
  const webServer = ctx.get ? ctx.get("webServer") : ctx.webServer;
  if (webServer === undefined || typeof webServer.register !== "function") {
    log.error?.("ssh-explorer: 取不到 webServer 服务，路由未注册");
    return;
  }

  ctx.effect(() => {
    const disposers = [];
    for (const route of ROUTES) {
      const wrapped = async (req, res) => {
        try {
          if (!originAllowed(req)) {
            sendJson(res, 403, { ok: false, error: "跨站请求被拒绝" });
            return;
          }
          await route.handler(req, res);
        } catch (error) {
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        }
      };
      const dispose = webServer.register({ kind: "exact", path: route.path, handler: wrapped });
      if (typeof dispose === "function") disposers.push(dispose);
    }
    log.info?.(`ssh-explorer: 已注册 ${disposers.length} 条路由于 ${ROUTE_PREFIX}`);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 卸载期间的清理失败无需上抛 */
        }
      }
    };
  }, "ssh-explorer: routes");
}
