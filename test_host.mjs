/**
 * 重启前的集成自检：用假的 ctx 把宿主半边跑起来，直接打它的路由处理器。
 *
 * 这一步能在**不重启 DSH** 的前提下证明三件事：
 *   1. `apply()` 能正确从 ctx 取到 webServer 并注册路由
 *   2. 每个路由处理器都能被调用（无语法/import/逻辑错误）
 *   3. 真机 SSH → 远端 python3 → JSON 这条链是通的，能列出 ubuntu 虚拟机里的目录
 *
 * 用法：node test_host.mjs
 */

import { apply } from "./plugin/lib/index.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const routes = new Map();

/** 假的插件上下文：只实现宿主半边真正用到的三个面。 */
const ctx = {
  logger: console,
  get(name) {
    if (name !== "webServer") return undefined;
    return {
      register(route) {
        routes.set(`${route.kind} ${route.path}`, route.handler);
        return () => routes.delete(`${route.kind} ${route.path}`);
      },
    };
  },
  effect(fn) {
    fn();
  },
};

apply(ctx);

console.log(`注册到 ${routes.size} 条路由：`);
for (const key of routes.keys()) console.log(`  ${key}`);
console.log("");

/**
 * 用假的 req/res 调一条路由。
 *
 * `body` 给定时会在处理器订阅完事件之后再推给它 —— 不能同步推，
 * 因为 `readJsonBody` 是先 `on("data")` 再等 chunk 的。
 */
function call(path, method = "GET", headers = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const handler = routes.get(`exact ${path.split("?")[0]}`);
    if (!handler) {
      reject(new Error(`路由没注册：${path}`));
      return;
    }
    const listeners = new Map();
    const req = {
      method,
      url: path,
      headers,
      destroy() {},
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
        return req;
      },
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      headers: {},
      setHeader(key, value) {
        this.headers[key] = value;
      },
      end(payload) {
        this.headersSent = true;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          parsed = payload;
        }
        resolve({ status: this.statusCode, body: parsed });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
    if (body !== undefined) {
      setImmediate(() => {
        for (const fn of listeners.get("data") ?? []) fn(Buffer.from(JSON.stringify(body), "utf8"));
        for (const fn of listeners.get("end") ?? []) fn();
      });
    }
  });
}

let failures = 0;

/** 断言并打印。 */
function report(label, condition, detail) {
  if (condition) {
    console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. 连接清单
const connections = await call("/x-ssh-explorer/connections");
report("GET /connections 返回 200", connections.status === 200, `status=${connections.status}`);
report(
  "ssh 可执行文件可用",
  connections.body.sshAvailable === true,
  `sshAvailable=${connections.body.sshAvailable}`,
);
const list = connections.body.connections ?? [];
console.log(`       发现 ${list.length} 个连接：${list.map((c) => c.id).join(", ") || "（无）"}`);
// 测试机：`RE_TEST_HOST=<别名>` 指定，否则用 ~/.ssh/config 里的第一台。
const ubuntu =
  (process.env.RE_TEST_HOST
    ? list.find((c) => c.name === process.env.RE_TEST_HOST || c.id === process.env.RE_TEST_HOST)
    : undefined) ??
  list.find((c) => c.source === "ssh-config" && typeof c.host === "string" && c.host.length > 0);
report("从 ~/.ssh/config 解析出测试连接", Boolean(ubuntu), ubuntu ? JSON.stringify(ubuntu) : "没找到");

if (!ubuntu) {
  console.log("\n拿不到测试连接，后续用例跳过。");
  process.exit(failures === 0 ? 0 : 1);
}

/** 直接跑一条远端命令（摆测试数据 / 改权限用，不经过插件）。 */
function sshRun(command) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
  if (ubuntu.port) args.push("-p", String(ubuntu.port));
  if (ubuntu.identityFile) args.push("-i", ubuntu.identityFile);
  args.push(`${ubuntu.user ?? "root"}@${ubuntu.host}`, command);
  return execFileSync("ssh", args, { encoding: "utf8" });
}

// ── 2. 连通性
const ping = await call(`/x-ssh-explorer/ping?connection=${encodeURIComponent(ubuntu.id)}`);
report("GET /ping 通", ping.body.ok === true, `${ping.body.elapsedMs}ms ${ping.body.message || ""}`);

// ── 3. 主机概况
const info = await call(`/x-ssh-explorer/info?connection=${encodeURIComponent(ubuntu.id)}`);
report("GET /info 拿到主机名", info.body.ok === true && Boolean(info.body.hostname), JSON.stringify(info.body));

// ── 4. 列家目录
const home = await call(`/x-ssh-explorer/list?connection=${encodeURIComponent(ubuntu.id)}`);
report("GET /list 列出家目录", home.body.ok === true, `path=${home.body.path} 共 ${(home.body.entries ?? []).length} 项`);
if (home.body.ok === true) {
  const names = (home.body.entries ?? []).slice(0, 6).map((e) => `${e.name}${e.dir ? "/" : ""}`);
  console.log(`       前 6 项：${names.join("  ")}`);
  const desktop = (home.body.entries ?? []).find((e) => e.name === "桌面");
  report("家目录里有「桌面」", Boolean(desktop), desktop ? `mode=${desktop.mode} dir=${desktop.dir}` : "没找到");
}

// ── 5. 列子目录（走一次路径拼接）
if (home.body.ok === true) {
  const target = `${home.body.path}/桌面`;
  const sub = await call(
    `/x-ssh-explorer/list?connection=${encodeURIComponent(ubuntu.id)}&path=${encodeURIComponent(target)}`,
  );
  report("GET /list 能进子目录", sub.body.ok === true, `path=${sub.body.path} 共 ${(sub.body.entries ?? []).length} 项`);
}

// ── 6. 读文件
const read = await call(
  `/x-ssh-explorer/read?connection=${encodeURIComponent(ubuntu.id)}&path=${encodeURIComponent("/etc/hostname")}`,
);
report(
  "GET /read 读到 /etc/hostname",
  read.body.ok === true && read.body.binary === false,
  JSON.stringify(String(read.body.text ?? "").trim()),
);

// ── 7. 读不存在的东西要优雅失败
const missing = await call(
  `/x-ssh-explorer/read?connection=${encodeURIComponent(ubuntu.id)}&path=${encodeURIComponent("/nope/nope")}`,
);
report("GET /read 对不存在的路径返回 ok=false 而不是崩", missing.body.ok === false, missing.body.error);

// ── 8. 错误处理
const badConnection = await call("/x-ssh-explorer/list?connection=nope");
report("GET /list 对未知连接返回 404", badConnection.status === 404, JSON.stringify(badConnection.body));

const wrongMethod = await call("/x-ssh-explorer/read", "POST");
report("POST /read 返回 405", wrongMethod.status === 405, JSON.stringify(wrongMethod.body));

// ── 9. 同源栅栏
const crossSite = await call("/x-ssh-explorer/connections", "GET", { "sec-fetch-site": "cross-site" });
report("跨站请求被拒（403）", crossSite.status === 403, JSON.stringify(crossSite.body));

const sameOrigin = await call("/x-ssh-explorer/connections", "GET", {
  origin: "http://127.0.0.1:19387",
  host: "127.0.0.1:19387",
});
report("同源请求放行", sameOrigin.status === 200, `status=${sameOrigin.status}`);

const evilOrigin = await call("/x-ssh-explorer/connections", "GET", {
  origin: "http://evil.example",
  host: "127.0.0.1:19387",
});
report("异源请求被拒（403）", evilOrigin.status === 403, JSON.stringify(evilOrigin.body));

// ── 10. 每连接独立密码（用户实际关心的问题：不同机器密码不一样怎么办）
//
// 这一段会真改 ~/.dsh/ssh-explorer/ 下的连接清单与口令库，所以先备份、
// 结尾无论如何都还原，测试连接也自己删掉。

const STORE_DIR = join(homedir(), ".dsh", "ssh-explorer");
const CONN_FILE = join(STORE_DIR, "connections.json");
const SECRETS_FILE = join(STORE_DIR, "secrets.json");
const HIDDEN_FILE = join(STORE_DIR, "hidden.json");
const ASKPASS_LOG = join(STORE_DIR, "askpass-verify.log");
const SSH_CONFIG_FILE = join(homedir(), ".ssh", "config");

const backup = new Map();
for (const file of [CONN_FILE, SECRETS_FILE, HIDDEN_FILE]) {
  backup.set(file, existsSync(file) ? readFileSync(file) : null);
}
function restoreAll() {
  for (const [file, bytes] of backup) {
    try {
      if (bytes === null) {
        if (existsSync(file)) rmSync(file);
      } else {
        writeFileSync(file, bytes);
      }
    } catch {
      /* 还原失败也不能让测试崩掉 */
    }
  }
  try {
    if (existsSync(ASKPASS_LOG)) rmSync(ASKPASS_LOG);
  } catch {
    /* 同上 */
  }
}
process.on("exit", restoreAll);

const post = (body) => call("/x-ssh-explorer/connections", "POST", {}, body);
const PW_A = "dsh-verify-wrong-A-9f3k";
const PW_B = "dsh-verify-wrong-B-7c1q";
// 用上面发现的那台测试机的地址与用户：写死 IP 会因为换网段而假失败。
const TEST_HOST = ubuntu.host;
const TEST_USER = ubuntu.user || "root";
// 本机真机上可能早就给别的连接存过口令，先记下来，后面断言只比较「新增了哪些」。
const BASELINE_MARKED = new Set(
  (
    (await call("/x-ssh-explorer/connections")).body.connections ?? []
  )
    .filter((c) => c.hasPassword === true)
    .map((c) => c.id),
);

const savedA = await post({
  action: "save",
  connection: { name: "verify-A", host: TEST_HOST, user: TEST_USER, authType: "password", password: PW_A },
});
const savedB = await post({
  action: "save",
  connection: { name: "verify-B", host: TEST_HOST, user: TEST_USER, authType: "password", password: PW_B },
});
const idA = savedA.body?.connection?.id;
const idB = savedB.body?.connection?.id;
report(
  "能建两条带密码的连接，且 id 不冲突",
  savedA.body?.ok === true && savedB.body?.ok === true && idA !== idB,
  `${idA} / ${idB}`,
);
report("保存时带上 authType", savedA.body?.connection?.authType === "password", `authType=${savedA.body?.connection?.authType}`);
report("新建即标记已有密码", savedA.body?.connection?.hasPassword === true, `hasPassword=${savedA.body?.connection?.hasPassword}`);
report("响应里不回传口令本身", !JSON.stringify(savedA.body).includes(PW_A), "响应体不含明文口令");

const secretsRaw = existsSync(SECRETS_FILE) ? readFileSync(SECRETS_FILE, "utf8") : "";
let secretsJson = {};
try {
  secretsJson = secretsRaw ? JSON.parse(secretsRaw) : {};
} catch {
  secretsJson = {};
}
report(
  "两条连接各存一份密文，且明文不落盘",
  typeof secretsJson[idA] === "string" && typeof secretsJson[idB] === "string" && !secretsRaw.includes(PW_A) && !secretsRaw.includes(PW_B),
  `键=${Object.keys(secretsJson).join(",")}`,
);
report("两份密文互不相同（各管各的）", secretsJson[idA] !== secretsJson[idB], "密文不同");

// 独立解密：不用插件的 dpapi.ps1，测试自己写一段 PowerShell 把密文解开，
// 再和当初设的口令逐字符比。这一步才真正证明「存进去的能取出来」，
// 而不是「存进去之后怎么都解不开、反正 ssh 也会失败」。
function independentDecrypt(b64) {
  const outFile = join(tmpdir(), `dsh-independent-${process.pid}-${Date.now()}.txt`);
  const escaped = outFile.replace(/\\/g, "\\\\");
  const script = [
    "Add-Type -AssemblyName System.Security;",
    `$x = [Convert]::FromBase64String('${b64}');`,
    "$y = [Security.Cryptography.ProtectedData]::Unprotect($x, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);",
    `[IO.File]::WriteAllText('${escaped}', [Convert]::ToBase64String($y), [Text.Encoding]::ASCII);`,
  ].join(" ");
  const psExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    execFileSync(psExe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      timeout: 20000,
    });
    return { ok: true, value: Buffer.from(readFileSync(outFile, "ascii").trim(), "base64").toString("utf8") };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error).slice(0, 160) };
  } finally {
    rmSync(outFile, { force: true });
  }
}

const decA = independentDecrypt(secretsJson[idA]);
const decB = independentDecrypt(secretsJson[idB]);
report(
  "独立解密密文能还原出原口令（A）",
  decA.ok && decA.value === PW_A,
  decA.ok ? `解出 "${decA.value}"（期望 "${PW_A}"）` : `解密失败：${decA.message}`,
);
report(
  "独立解密密文能还原出原口令（B）",
  decB.ok && decB.value === PW_B,
  decB.ok ? `解出 "${decB.value}"（期望 "${PW_B}"）` : `解密失败：${decB.message}`,
);
report("两条连接的密文解出来确实不同", decA.ok && decB.ok && decA.value !== decB.value, "A 与 B 口令不同");

const afterSave = (await call("/x-ssh-explorer/connections")).body.connections ?? [];
const marked = afterSave.filter((c) => c.hasPassword === true).map((c) => c.id).sort();
const expectedMarked = [...BASELINE_MARKED, idA, idB].sort();
report(
  "hasPassword 只标在设过密码的连接上",
  JSON.stringify(marked) === JSON.stringify(expectedMarked),
  `被标记=${marked.join(",")} 期望=${expectedMarked.join(",")}`,
);

// ── 真的走密码路径：故意用错口令，看 ssh 的报错签名
if (existsSync(ASKPASS_LOG)) rmSync(ASKPASS_LOG);
process.env.DSH_SSH_EXPLORER_ASKPASS_LOG = ASKPASS_LOG;

const pingA = await call(`/x-ssh-explorer/ping?connection=${encodeURIComponent(idA)}`);
const pingMsg = String(pingA.body?.message ?? "");
report("错口令时 ping 必须失败（不能蒙混过关）", pingA.body?.ok === false, pingMsg.slice(0, 140));

// ⚠ 曾经这里断言「报错里只有 password、没有 publickey」，那是错的断言，已删除。
// 实测（手工验证过）：ssh 的 `Permission denied (publickey,password)` 括号里列的是
// **服务端支持的方法**，不是本次尝试过的认证方式。即使带上
// `-o PubkeyAuthentication=no -o PreferredAuthentications=password`，ssh 照样打印
// `(publickey,password)`。所以拿报错签名判断「走没走密码路径」是不成立的。
// 真正有效的判据是下面这条：askpass 被调用了 = 密码路径确实走到了。

const askLog = existsSync(ASKPASS_LOG) ? readFileSync(ASKPASS_LOG, "utf8").trim() : "";
report("ssh 确实调用了 askpass 来取口令", askLog.length > 0, askLog.split("\n").at(-1) ?? "");
report("askpass 收到的提示语是口令询问", /password/i.test(askLog), askLog.slice(0, 160));
report("askpass 日志里不含明文口令", !askLog.includes(PW_A), "日志只记提示语");

// ── 清除一条不能影响另一条（这就是「密码不一样」的核心诉求）
const cleared = await post({ action: "secret", id: idA, clear: true });
report("能清除单条连接的口令", cleared.body?.ok === true, JSON.stringify(cleared.body));
let secretsAfter = {};
try {
  secretsAfter = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, "utf8")) : {};
} catch {
  secretsAfter = {};
}
report(
  "清除只影响这一条，另一条仍在",
  secretsAfter[idA] === undefined && typeof secretsAfter[idB] === "string",
  `剩余键=${Object.keys(secretsAfter).join(",")}`,
);

const afterClear = (await call("/x-ssh-explorer/connections")).body.connections ?? [];
const markedAfter = afterClear.filter((c) => c.hasPassword === true).map((c) => c.id);
report(
  "清除后 hasPassword 变 false",
  !markedAfter.includes(idA) && markedAfter.includes(idB),
  `被标记=${markedAfter.join(",")}`,
);

// ── 编辑连接时不带 password，不能把已存口令弄丢
const edited = await post({
  action: "save",
  connection: { id: idB, name: "verify-B", host: TEST_HOST, user: TEST_USER, authType: "key" },
});
report("改认证方式成功", edited.body?.ok === true, `authType=${edited.body?.connection?.authType}`);
report("编辑不带 password 时保留原口令", edited.body?.connection?.hasPassword === true, `hasPassword=${edited.body?.connection?.hasPassword}`);
report(
  "改认证方式没动密文本身",
  (() => {
    try {
      return JSON.parse(readFileSync(SECRETS_FILE, "utf8"))[idB] === secretsJson[idB];
    } catch {
      return false;
    }
  })(),
  "密文逐字符未变",
);

// ── 清理
for (const id of [idA, idB]) await post({ action: "delete", id });
const finalList = (await call("/x-ssh-explorer/connections")).body.connections ?? [];
report("测试连接已清理并连带删除口令", !finalList.some((c) => c.id === idA || c.id === idB), `剩 ${finalList.length} 条`);
{
  let left = {};
  try {
    left = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, "utf8")) : {};
  } catch {
    left = {};
  }
  report("删连接时口令也一起删掉", left[idA] === undefined && left[idB] === undefined, `剩余键=${Object.keys(left).join(",") || "（空）"}`);
}

delete process.env.DSH_SSH_EXPLORER_ASKPASS_LOG;
restoreAll();

// ── 10.5 模型清单与模型选择（路由级，不打真网关）

console.log("");
console.log("── 10.5 模型清单与模型选择");

const modelsRes = await call("/x-ssh-explorer/chat-models");
report("GET /chat-models 返回 200", modelsRes.status === 200, `status=${modelsRes.status}`);
report(
  "返回了模型清单",
  Array.isArray(modelsRes.body?.models) && modelsRes.body.models.length >= 1,
  `count=${modelsRes.body?.models?.length ?? 0}`,
);
report(
  "清单里至少有一个 cn: 前缀的模型",
  (modelsRes.body?.models ?? []).some((id) => String(id).startsWith("cn:")),
  (modelsRes.body?.models ?? []).slice(0, 4).join(","),
);
report(
  "带上了当前默认模型",
  typeof modelsRes.body?.current === "string" && modelsRes.body.current.length > 0,
  `current=${modelsRes.body?.current}`,
);

// 分组：应该来自用户 「设置 → 模型」里配过的提供商（profile 的 cordis.patch.yml）。
const modelGroups = Array.isArray(modelsRes.body?.providers) ? modelsRes.body.providers : [];
const groupedIds = modelGroups.flatMap((group) => group.models.map((item) => item.id));
report(
  "带上了 providers 分组（读的是用户配过的提供商）",
  modelGroups.length >= 1,
  `groups=${modelGroups.map((g) => `${g.name}(${g.models.length})`).join(" / ") || "（无，会退回平铺）"}`,
);
report(
  "每个分组都有 baseURL",
  modelGroups.every((g) => typeof g.baseURL === "string" && g.baseURL.startsWith("http")),
  modelGroups.map((g) => `${g.name}→${g.baseURL}`).join(" / ") || "（无）",
);
report(
  "分组里的模型都带显示名",
  modelGroups.every((g) => g.models.every((m) => typeof m.name === "string" && m.name.length > 0)),
  modelGroups.map((g) => g.models.map((m) => m.name).join("|")).join(" / ") || "（无）",
);
report(
  "models 扁平清单以分组模型开头（顺序稳定）",
  groupedIds.length === 0 ||
    modelsRes.body.models.slice(0, groupedIds.length).join(",") === groupedIds.join(","),
  `head=${(modelsRes.body?.models ?? []).slice(0, 3).join(",")}`,
);
report(
  "extra 与分组不重叠",
  !(modelsRes.body?.extra ?? []).some((id) => groupedIds.includes(id)),
  `extra=${(modelsRes.body?.extra ?? []).length} 个`,
);
report(
  "分组模型与 extra 合起来覆盖全部 models",
  new Set(groupedIds.concat(modelsRes.body?.extra ?? [])).size >=
    (modelsRes.body?.models ?? []).length,
  `分组+extra=${new Set(groupedIds.concat(modelsRes.body?.extra ?? [])).size} models=${(modelsRes.body?.models ?? []).length}`,
);

const modelsWrongMethod = await call("/x-ssh-explorer/chat-models", "POST");
report("POST /chat-models 返回 405", modelsWrongMethod.status === 405, `status=${modelsWrongMethod.status}`);

const modelsCross = await call("/x-ssh-explorer/chat-models", "GET", { origin: "http://evil.example" });
report("跨站 GET /chat-models 被拒（403）", modelsCross.status === 403, `status=${modelsCross.status}`);

const badModel = await call("/x-ssh-explorer/chat-config", "POST", { "content-type": "application/json" }, {
  model: "坏 名 字\n",
});
report("非法 model 被拒（400）", badModel.status === 400, `status=${badModel.status} err=${badModel.body?.error ?? "-"}`);

const cfgFile = join(homedir(), ".dsh", "ssh-explorer", "chat.json");
const cfgBefore = existsSync(cfgFile) ? readFileSync(cfgFile, "utf8") : null;
const picked =
  (modelsRes.body?.models ?? []).find((id) => id !== modelsRes.body?.current) ?? modelsRes.body?.current;
const setModel = await call("/x-ssh-explorer/chat-config", "POST", { "content-type": "application/json" }, {
  model: picked,
});
report("POST /chat-config 返回 200", setModel.status === 200, `status=${setModel.status}`);
const cfgAfter = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : null;
report("选中的模型落盘到 chat.json", cfgAfter?.model === picked, `model=${cfgAfter?.model ?? "（无文件）"} picked=${picked}`);
const modelsAfterWrite = await call("/x-ssh-explorer/chat-models");
report(
  "换完之后 /chat-models 的 current 跟着变",
  modelsAfterWrite.body?.current === picked,
  `current=${modelsAfterWrite.body?.current}`,
);
if (cfgBefore === null) rmSync(cfgFile, { force: true });
else writeFileSync(cfgFile, cfgBefore, "utf8");
report(
  "chat.json 已还原",
  cfgBefore === null ? !existsSync(cfgFile) : readFileSync(cfgFile, "utf8") === cfgBefore,
  cfgBefore === null ? "（原本没有该文件）" : "还原完成",
);

// ── 11. AI 对话（真调本地模型网关 + 真走 SSH 工具，最慢的一段）

console.log("");
console.log("── 11. AI 对话");

const t0 = Date.now();
const PINNED_MODEL = "cn:deepseek-v4.1-flash";
const chat = await call("/x-ssh-explorer/chat", "POST", { "content-type": "application/json" }, {
  connectionId: ubuntu.id,
  path: "/home/admin",
  model: PINNED_MODEL,
  messages: [
    {
      role: "user",
      content: "用 ssh_list 看一下 /home/admin，然后只用一句话告诉我里面有哪些以点开头的项。不要解释过程。",
    },
  ],
});
const chatMs = Date.now() - t0;

report("POST /chat 返回 200", chat.status === 200, `status=${chat.status}`);
report("对话成功", chat.body?.ok === true, `ok=${chat.body?.ok} err=${chat.body?.error ?? "-"}`);
report("返回了非空回复", typeof chat.body?.reply === "string" && chat.body.reply.trim().length > 0,
  `reply="${String(chat.body?.reply ?? "").slice(0, 60)}"`);
report("带上了模型名", typeof chat.body?.model === "string" && chat.body.model.length > 0, `model=${chat.body?.model}`);
report("按请求里指定的模型跑", chat.body?.model === PINNED_MODEL, `model=${chat.body?.model} 期望=${PINNED_MODEL}`);
const chatSteps = Array.isArray(chat.body?.steps) ? chat.body.steps : [];
report("模型真的调了 SSH 工具", chatSteps.length >= 1, `steps=${chatSteps.map((s) => s.name).join(",") || "（无）"}`);
report(
  "工具调用带上了合法参数",
  chatSteps.length >= 1 && chatSteps[0].args && typeof chatSteps[0].args === "object",
  JSON.stringify(chatSteps[0]?.args ?? null),
);
report(
  "工具真的执行出了输出",
  chatSteps.length >= 1 && typeof chatSteps[0].output === "string" && chatSteps[0].output.length > 0,
  `output="${String(chatSteps[0]?.output ?? "").slice(0, 80)}"`,
);
console.log(`       对话耗时 ${chatMs} ms，工具 ${chatSteps.length} 次：${chatSteps.map((s) => s.name).join(", ")}`);
console.log(`       回复：${String(chat.body?.reply ?? "").slice(0, 160)}`);

// ── 11.1 选中别的提供商时，宿主要把 baseURL 一起切过去

/** 网关是否在线（能应答 /models 就算在线）。 */
async function gatewayAlive(baseURL) {
  try {
    const res = await fetch(`${String(baseURL).replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(4000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

const currentGroup = modelGroups.find((g) => g.models.some((m) => m.id === modelsRes.body?.current));
const otherGroup = modelGroups.find((g) => g !== currentGroup && g.models.length > 0);
if (!otherGroup) {
  console.log("");
  console.log("── 11.1 跨提供商切换（本次只配了一个提供商，跳过）");
} else {
  console.log("");
  console.log("── 11.1 跨提供商切换");
  const foreignModel = otherGroup.models[0].id;
  const foreignHost = new URL(otherGroup.baseURL).host;
  const alive = await gatewayAlive(otherGroup.baseURL);
  const foreignChat = await call("/x-ssh-explorer/chat", "POST", { "content-type": "application/json" }, {
    connectionId: ubuntu.id,
    path: "/home/admin",
    model: foreignModel,
    messages: [{ role: "user", content: "只回两个字：在吗" }],
  });
  if (alive) {
    // 网关在线但上游（chatgpt.com 之类）不通时会是 502 upstream_error —— 那也证明请求确实
    // 路由到了这个网关，不该算失败；只有「连不上模型网关 …」才是 baseURL 没切过去。
    const err = String(foreignChat.body?.error ?? "-");
    const routed = foreignChat.body?.ok === true || /HTTP 50\d/.test(err);
    report(
      `${otherGroup.name} 网关在线，请求确实路由到该提供商`,
      routed && !err.includes("连不上模型网关"),
      `ok=${foreignChat.body?.ok} err=${err.slice(0, 130)}`,
    );
  } else {
    report(
      `${otherGroup.name} 网关离线时，报错里带上 ${foreignHost}（证明 baseURL 真切过去了）`,
      foreignChat.body?.ok === false && String(foreignChat.body?.error ?? "").includes(foreignHost),
      `err=${String(foreignChat.body?.error ?? "-").slice(0, 160)}`,
    );
  }
  console.log(`       当前组=${currentGroup?.name ?? "(未知)"} → 目标组=${otherGroup.name} 模型=${foreignModel} 网关在线=${alive}`);
  await call("/x-ssh-explorer/chat-config", "POST", { "content-type": "application/json" }, {
    model: modelsRes.body?.current,
  });
}

const chatBad = await call("/x-ssh-explorer/chat", "POST", { "content-type": "application/json" }, {
  connectionId: ubuntu.id,
  messages: [],
});
report("空 messages 被拒", chatBad.body?.ok === false, `ok=${chatBad.body?.ok}`);

const chatUnknown = await call("/x-ssh-explorer/chat", "POST", { "content-type": "application/json" }, {
  connectionId: "不存在的连接",
  messages: [{ role: "user", content: "hi" }],
});
report("未知连接被拒", chatUnknown.body?.ok === false, `ok=${chatUnknown.body?.ok} err=${chatUnknown.body?.error ?? "-"}`);

const chatGet = await call("/x-ssh-explorer/chat");
report("GET /chat 返回 405", chatGet.status === 405, `status=${chatGet.status}`);

const chatCross = await call("/x-ssh-explorer/chat", "POST", {
  "content-type": "application/json",
  "sec-fetch-site": "cross-site",
}, { connectionId: ubuntu.id, messages: [{ role: "user", content: "hi" }] });
report("跨站 POST /chat 被拒（403）", chatCross.status === 403, `status=${chatCross.status}`);

// config.chat = false 时整条链路关掉
apply(ctx, { chat: false });
const chatOff = await call("/x-ssh-explorer/chat", "POST", { "content-type": "application/json" }, {
  connectionId: ubuntu.id,
  messages: [{ role: "user", content: "hi" }],
});
report("config.chat=false 时 /chat 返回 403", chatOff.status === 403, `status=${chatOff.status} err=${chatOff.body?.error ?? "-"}`);
const listOff = await call("/x-ssh-explorer/connections");
report("config.chat=false 时 /connections 报 chatEnabled=false", listOff.body?.chatEnabled === false, `chatEnabled=${listOff.body?.chatEnabled}`);
apply(ctx, {});
const listOn = await call("/x-ssh-explorer/connections");
report("恢复配置后 chatEnabled 回到 true", listOn.body?.chatEnabled === true, `chatEnabled=${listOn.body?.chatEnabled}`);

// ── 12. 编辑保存（POST /write）：内容走 stdin，原子替换 + 备份
const EDIT_DIR = "/tmp/dsh-re-edit";
// 先清干净，否则上一轮留下的文件会让「新建时 existed=false」这条断言失败（测试要可重复跑）。
sshRun(`rm -rf ${EDIT_DIR}`);
const write = (path, content) =>
  call("/x-ssh-explorer/write", "POST", { "content-type": "application/json" }, {
    connection: ubuntu.id,
    path,
    content,
  });
const readBack = (path) =>
  call(`/x-ssh-explorer/read?connection=${encodeURIComponent(ubuntu.id)}&path=${encodeURIComponent(path)}`);

// 故意塞满 shell 会咬人的字符：单引号、双引号、$、$()、反引号、中文。
const tricky =
  "print(\"it's $HOME $(whoami) `date` \\\"q\\\"\")\n" +
  "# 中文注释 ✅ 制表符\t结束\n" +
  "print('单引号里也不能坏')\n";

const v1 = await write(`${EDIT_DIR}/hello.py`, tricky);
report("POST /write 新建文件成功", v1.status === 200 && v1.body?.ok === true, `status=${v1.status} ${JSON.stringify(v1.body)}`);
report("新建时 existed=false", v1.body?.existed === false, `existed=${v1.body?.existed}`);
report(
  "返回字节数等于 UTF-8 长度",
  v1.body?.bytes === Buffer.byteLength(tricky, "utf8"),
  `bytes=${v1.body?.bytes} 期望=${Buffer.byteLength(tricky, "utf8")}`,
);

const back1 = await readBack(`${EDIT_DIR}/hello.py`);
report(
  "读回来内容逐字相同（$、反引号、单引号、中文都没坏）",
  back1.body?.ok === true && back1.body.text === tricky,
  back1.body?.text === tricky ? "完全一致" : `差异：${JSON.stringify(back1.body?.text ?? back1.body?.error).slice(0, 200)}`,
);

// 覆盖写：要留备份，且备份是上一版
const tricky2 = `${tricky}print('第二版')\n`;
const v2 = await write(`${EDIT_DIR}/hello.py`, tricky2);
report("POST /write 覆盖成功", v2.body?.ok === true, `ok=${v2.body?.ok} ${JSON.stringify(v2.body)}`);
report(
  "覆盖时 existed=true 且给了备份路径",
  v2.body?.existed === true && String(v2.body?.backup).endsWith(".re-bak"),
  `backup=${v2.body?.backup}`,
);
const bak = await readBack(String(v2.body?.backup));
report(
  "备份里是上一版内容",
  bak.body?.text === tricky,
  bak.body?.text === tricky ? "备份正确" : `备份内容：${JSON.stringify(bak.body?.text ?? bak.body?.error).slice(0, 160)}`,
);
report("覆盖后文件是新内容", (await readBack(`${EDIT_DIR}/hello.py`)).body?.text === tricky2, "新内容已落盘");

// 大文件：远超 32767 字符，argv 传必被截断，只有走 stdin 才对
let big = "";
for (let i = 0; big.length < 80000; i += 1) {
  big += `第 ${i} 行 abcdefghijklmnopqrstuvwxyz 0123456789\n`;
}
const bigBytes = Buffer.byteLength(big, "utf8");
const vBig = await write(`${EDIT_DIR}/big.txt`, big);
report(
  "大文件写入成功",
  vBig.body?.ok === true && vBig.body?.bytes === bigBytes,
  `bytes=${vBig.body?.bytes} 期望=${bigBytes}（${big.length} 字符）`,
);
const backBig = await readBack(`${EDIT_DIR}/big.txt`);
report(
  "大文件读回来逐字相同（证明走的是 stdin 而不是 argv）",
  backBig.body?.ok === true && backBig.body.text === big,
  backBig.body?.truncated ? "被截断了" : backBig.body?.text === big ? "完全一致" : "有差异",
);

// 覆盖已存在文件时要把权限位带回来。
// 先用 ssh 直接把权限改成 700（插件没有 chmod 接口，这一步是测试自己的前置条件），
// 再覆盖写，看新文件是不是保住了 700 —— 否则 SAVE_PY 里的 os.chmod 就是摆设。
await write(`${EDIT_DIR}/mode.sh`, "#!/bin/sh\necho v1\n");
sshRun(`chmod 700 ${EDIT_DIR}/mode.sh`);
const vMode = await write(`${EDIT_DIR}/mode.sh`, "#!/bin/sh\necho v2\n");
report("覆盖写保住原权限位 700", vMode.body?.mode === "0o700", `mode=${vMode.body?.mode}（覆盖前是 700）`);

// 边界与安全
const wUnknown = await call("/x-ssh-explorer/write", "POST", { "content-type": "application/json" }, {
  connection: "不存在的连接",
  path: "/tmp/x",
  content: "x",
});
report("POST /write 未知连接返回 404", wUnknown.status === 404, `status=${wUnknown.status}`);
const wNoPath = await call("/x-ssh-explorer/write", "POST", { "content-type": "application/json" }, {
  connection: ubuntu.id,
  path: "  ",
  content: "x",
});
report("POST /write 空 path 返回 400", wNoPath.status === 400, `status=${wNoPath.status} err=${wNoPath.body?.error}`);
const wBadContent = await call("/x-ssh-explorer/write", "POST", { "content-type": "application/json" }, {
  connection: ubuntu.id,
  path: "/tmp/x",
  content: 123,
});
report("POST /write 非字符串 content 返回 400", wBadContent.status === 400, `status=${wBadContent.status} err=${wBadContent.body?.error}`);
const wGet = await call("/x-ssh-explorer/write");
report("GET /write 返回 405", wGet.status === 405, `status=${wGet.status}`);
const wCross = await call(
  "/x-ssh-explorer/write",
  "POST",
  { "content-type": "application/json", "sec-fetch-site": "cross-site" },
  { connection: ubuntu.id, path: "/tmp/x", content: "x" },
);
report("跨站 POST /write 被拒（403）", wCross.status === 403, `status=${wCross.status}`);

// ────────────────────────────── 远端终端：POST /exec
//
// 每条命令单开一次 ssh，靠 EXIT trap 回传退出码与最终 cwd。这里验的就是那套标记协议：
// cwd 能不能累积、退出码是不是真的、stderr 有没有分开、边界有没有守住。

const EXEC_DIR = "/tmp/dsh-re-exec";
sshRun(`mkdir -p ${EXEC_DIR}`);

/** `/exec` 收的是 connectionId（跟 `/chat` 一致），这里替调用方做一次名字转换。 */
const exec = (body, headers) =>
  call(
    "/x-ssh-explorer/exec",
    "POST",
    { "content-type": "application/json", ...(headers ?? {}) },
    {
      connectionId: body.connectionId ?? body.connection,
      command: body.command,
      cwd: body.cwd,
      timeoutMs: body.timeoutMs,
    },
  );

const e1 = await exec({ connection: ubuntu.id, command: "echo hello-remote" });
report(
  "POST /exec 基本命令成功",
  e1.body?.ok === true && String(e1.body?.stdout ?? "").includes("hello-remote"),
  `code=${e1.body?.code} out=${JSON.stringify(String(e1.body?.stdout ?? "").trim())}`,
);
report("成功时退出码是 0", e1.body?.code === 0, `code=${e1.body?.code}`);
report(
  "默认回传了 cwd",
  typeof e1.body?.cwd === "string" && e1.body.cwd.startsWith("/"),
  `cwd=${e1.body?.cwd}`,
);

// cwd 累积：第一条 cd 进去，第二条应当就在那个目录里跑
const e2 = await exec({ connection: ubuntu.id, command: `cd ${EXEC_DIR}` });
report("cd 之后回传的 cwd 变了", e2.body?.cwd === EXEC_DIR, `cwd=${e2.body?.cwd}`);
const e3 = await exec({ connection: ubuntu.id, command: "pwd", cwd: e2.body?.cwd });
report(
  "cwd 会累积到下一条命令（pwd 一致）",
  String(e3.body?.stdout ?? "").trim() === EXEC_DIR,
  `pwd=${JSON.stringify(String(e3.body?.stdout ?? "").trim())}`,
);

// 退出码：显式 exit 3 必须是真的 3（靠 EXIT trap 而不是命令后追加 printf）
const e4 = await exec({ connection: ubuntu.id, command: "exit 3" });
report("exit 3 的退出码是真的", e4.body?.code === 3, `code=${e4.body?.code}`);
const e5 = await exec({ connection: ubuntu.id, command: "false" });
report("false 的退出码是 1", e5.body?.code === 1, `code=${e5.body?.code}`);

// stderr 与 stdout 分开
const e6 = await exec({ connection: ubuntu.id, command: "echo 到标准输出; echo 到标准错误 >&2" });
report("stdout 与 stderr 分开回传", String(e6.body?.stdout ?? "").includes("到标准输出") && String(e6.body?.stderr ?? "").includes("到标准错误"), `out=${JSON.stringify(String(e6.body?.stdout ?? "").trim())} err=${JSON.stringify(String(e6.body?.stderr ?? "").trim())}`);
report("标记没有漏进 stdout", !String(e6.body?.stdout ?? "").includes("__DSH_RE_EXEC"), "标记已剥离");

// cwd 不存在 → 回落 HOME，不报错
const e7 = await exec({ connection: ubuntu.id, command: "pwd", cwd: "/tmp/根本没有这个目录-9f3k" });
report("cwd 不存在时回落到 HOME", e7.body?.ok === true && String(e7.body?.stdout ?? "").trim().startsWith("/"), `code=${e7.body?.code} pwd=${String(e7.body?.stdout ?? "").trim()}`);

// 多行输出原样保留
const e8 = await exec({ connection: ubuntu.id, command: "printf 'a\\nb\\nc\\n'" });
report("多行输出原样保留", String(e8.body?.stdout ?? "") === "a\nb\nc\n", JSON.stringify(String(e8.body?.stdout ?? "")));

// 特殊字符：单引号/双引号/反引号/美元符/中文都不能被 shell 吃掉
const e9 = await exec({ connection: ubuntu.id, command: `printf '%s' "它会 \\"引号\\" 和 '单引号' 和 $HOME"` });
report(
  "引号与 $ 原样传给远端",
  String(e9.body?.stdout ?? "").includes("引号") && String(e9.body?.stdout ?? "").includes("单引号"),
  JSON.stringify(String(e9.body?.stdout ?? "").slice(0, 80)),
);

// 超时
const e10 = await exec({ connection: ubuntu.id, command: "sleep 5", timeoutMs: 1200 });
report("超时会返回失败而不是挂住", e10.body?.ok === false, `ok=${e10.body?.ok} err=${String(e10.body?.error ?? "").slice(0, 60)}`);

// 边界与安全
const e11 = await exec({ connection: ubuntu.id, command: "   " });
report("空命令返回 400", e11.status === 400, `status=${e11.status} err=${e11.body?.error}`);
const e12 = await exec({ connection: ubuntu.id, command: "x".repeat(9000) });
report("超长命令返回 400", e12.status === 400, `status=${e12.status} err=${String(e12.body?.error ?? "").slice(0, 60)}`);
const e13 = await exec({ connection: "不存在的连接", command: "echo x" });
report("未知连接返回 404", e13.status === 404, `status=${e13.status}`);
const e14 = await call("/x-ssh-explorer/exec");
report("GET /exec 返回 405", e14.status === 405, `status=${e14.status}`);
const e15 = await exec(
  { connection: ubuntu.id, command: "echo x" },
  { "sec-fetch-site": "cross-site" },
);
report("跨站 POST /exec 被拒（403）", e15.status === 403, `status=${e15.status}`);

// ── 14. 删除设备（扫尾段：放在所有走 SSH 的用例之后，因为隐藏 ubuntu 会让后续用例连不上）
console.log("");
console.log("── 14. 删除设备");

const configBefore = existsSync(SSH_CONFIG_FILE) ? readFileSync(SSH_CONFIG_FILE, "utf8") : "";
const hiddenOf = async () => (await call("/x-ssh-explorer/connections")).body?.hidden ?? [];
const listOf = async () => (await call("/x-ssh-explorer/connections")).body?.connections ?? [];

report("GET /connections 带 hidden 名单", Array.isArray(await hiddenOf()), "hidden 是数组");

// 14.1 来自 ~/.ssh/config 的主机：删 = 从清单隐藏，配置文件一个字节都不动
const hideOne = await post({ action: "delete", id: ubuntu.id });
report(
  "删 ssh-config 主机走隐藏（hiddenOnly=true）",
  hideOne.status === 200 && hideOne.body?.ok === true && hideOne.body?.hiddenOnly === true,
  JSON.stringify(hideOne.body),
);
const listAfterHide = await listOf();
const hiddenAfterHide = await hiddenOf();
report(
  "删完就从连接清单里消失",
  !listAfterHide.some((c) => c.id === ubuntu.id),
  `剩 ${listAfterHide.length} 条`,
);
report(
  "被删的主机进了「已删除」名单，带名字/主机/时间",
  hiddenAfterHide.some((c) => c.id === ubuntu.id && typeof c.name === "string" && typeof c.hiddenAt === "number"),
  JSON.stringify(hiddenAfterHide.find((c) => c.id === ubuntu.id) ?? null),
);
report(
  "~/.ssh/config 一个字节都没改",
  (existsSync(SSH_CONFIG_FILE) ? readFileSync(SSH_CONFIG_FILE, "utf8") : "") === configBefore,
  "配置文件未变",
);
const pingHidden = await call(`/x-ssh-explorer/ping?connection=${encodeURIComponent(ubuntu.id)}`);
report("被隐藏的连接连 ping 都找不到（404）", pingHidden.status === 404, `status=${pingHidden.status}`);
const listHidden = await call(
  `/x-ssh-explorer/list?connection=${encodeURIComponent(ubuntu.id)}&path=${encodeURIComponent("/tmp")}`,
);
report("被隐藏的连接列目录也 404", listHidden.status === 404, `status=${listHidden.status}`);

// 14.2 恢复
const restored = await post({ action: "restore", id: ubuntu.id });
report("能恢复（restore）", restored.status === 200 && restored.body?.ok === true, JSON.stringify(restored.body));
report(
  "恢复后回到连接清单、并从「已删除」里移除",
  (await listOf()).some((c) => c.id === ubuntu.id) && !(await hiddenOf()).some((c) => c.id === ubuntu.id),
  "已回到清单",
);
const pingBack = await call(`/x-ssh-explorer/ping?connection=${encodeURIComponent(ubuntu.id)}`);
report("恢复后立刻能连上（说明只是清单层面隐藏）", pingBack.body?.ok === true, `${pingBack.body?.elapsedMs}ms`);

// 14.3 自建连接：删 = 真删，不进「已删除」（否则会越积越多）
const doomed = await post({
  action: "save",
  connection: { name: "verify-doomed", host: TEST_HOST, user: TEST_USER, authType: "key" },
});
const doomedId = doomed.body?.connection?.id;
const killStored = await post({ action: "delete", id: doomedId });
report(
  "删自建连接走真删（hiddenOnly=false）",
  killStored.body?.ok === true && killStored.body?.hiddenOnly === false,
  JSON.stringify(killStored.body),
);
report(
  "真删的不进「已删除」名单",
  !(await hiddenOf()).some((c) => c.id === doomedId),
  "名单里没有它",
);
let connJson = {};
try {
  connJson = JSON.parse(existsSync(CONN_FILE) ? readFileSync(CONN_FILE, "utf8") : "{}");
} catch {
  connJson = {};
}
report(
  "真删的已从 connections.json 里移除",
  !JSON.stringify(connJson).includes(String(doomedId)),
  `文件里剩 ${Array.isArray(connJson.connections) ? connJson.connections.length : 0} 条`,
);

// 14.4 边界
const badDelete = await post({ action: "delete" });
report("delete 不带 id 返回 400", badDelete.status === 400, `status=${badDelete.status}`);
const ghostDelete = await post({ action: "delete", id: "ssh-config:根本没有这台-9f3k" });
report(
  "删一个不存在的 id 不报错（幂等，removed=false）",
  ghostDelete.status === 200 && ghostDelete.body?.removed === false,
  JSON.stringify(ghostDelete.body),
);
const ghostRestore = await post({ action: "restore", id: "ssh-config:根本没有这台-9f3k" });
report("恢复一个不在名单里的 id 也幂等", ghostRestore.status === 200 && ghostRestore.body?.ok === true, JSON.stringify(ghostRestore.body));

console.log("");
console.log(failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
