/**
 * 拖拽传输的端到端测试（真的 ssh，真的写文件）。
 *
 * 不起 DSH 本体：直接 import 插件的 `apply`，把路由挂到一个临时 http server，
 * 再用 fetch 打那几个传输端点 —— 和真实运行时的差别只有 webServer 这一层。
 *
 * 需要一台能 ssh 的 Linux 主机（`~/.ssh/config` 里有就能自动挑一台，
 * 也可以用 `RE_TEST_HOST=<别名>` 指定）。没有可用主机时整份测试跳过，不算失败。
 *
 * 覆盖：落点探测、拉目录（中文名/嵌套/二进制/mtime）、拉单文件、同名不覆盖、
 *       推目录、推单文件、字节流兜底上传、取消、参数校验。
 *
 * 用法：node test_transfer.mjs
 */
import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { apply } = await import(pathToFileURL(fileURLToPath(new URL("./plugin/lib/index.js", import.meta.url))).href);

let failures = 0;
function report(label, condition, detail = "") {
  if (condition) console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 假 ctx：只实现 webServer.register 与 effect
const routes = new Map();
apply(
  {
    get: (key) =>
      key === "webServer"
        ? {
            register: (route) => {
              routes.set(route.path, route.handler);
              return () => routes.delete(route.path);
            },
          }
        : undefined,
    effect: (fn) => {
      fn();
      return () => undefined;
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  },
  {},
);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const handler = routes.get(url.pathname);
  if (handler === undefined) {
    response.statusCode = 404;
    response.end("no route");
    return;
  }
  try {
    await handler(request, response);
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error?.message ?? error));
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function pollJob(id, { timeoutMs = 180000 } = {}) {
  const started = Date.now();
  for (;;) {
    const response = await api("GET", `/x-ssh-explorer/job?id=${encodeURIComponent(id)}`);
    const job = response.body?.job;
    if (job !== undefined && job.state !== "running") return job;
    if (Date.now() - started > timeoutMs) throw new Error(`job timeout: ${JSON.stringify(job)}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

// ── 挑一台测试机
const connections = await api("GET", "/x-ssh-explorer/connections");
const list = connections.body?.connections ?? [];
const target =
  list.find((item) => process.env.RE_TEST_HOST && item.name === process.env.RE_TEST_HOST) ??
  list.find((item) => item.source === "ssh-config" && typeof item.host === "string" && item.host.length > 0);
if (target === undefined) {
  console.log("没有可用的 ssh 连接，整份传输测试跳过（不算失败）。");
  server.close();
  process.exit(0);
}
console.log(`测试机：${target.name} (${target.user}@${target.host}:${target.port ?? 22})`);

/** 在远端跑一条命令（只用来摆测试数据与核对结果）。 */
function ssh(argv) {
  return new Promise((resolve) => {
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
    if (target.port) args.push("-p", String(target.port));
    if (target.identityFile) args.push("-i", target.identityFile);
    args.push(`${target.user}@${target.host}`, argv);
    execFile("ssh", args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

const REMOTE = "/tmp/re-e2e";
const LOCAL = join(tmpdir(), "re-transfer-test");
const MTIME = "1709499967"; // 2024-03-03T21:06:07Z，用来验证 mtime 还原

await ssh(
  [
    `rm -rf ${REMOTE}`,
    `mkdir -p "${REMOTE}/中文 目录/sub"`,
    `printf 'hello-中文\\n' > "${REMOTE}/中文 目录/a1.txt"`,
    `printf 'BI\\x00\\x01\\xff' > "${REMOTE}/中文 目录/sub/b2.bin"`,
    `touch -d '2024-03-04 05:06:07' "${REMOTE}/中文 目录/a1.txt"`,
    `mkdir -p ${REMOTE}/up`,
  ].join(" && "),
);
await rm(LOCAL, { recursive: true, force: true });
await mkdir(LOCAL, { recursive: true });

// ── 1. 落点探测
const locals = await api("GET", "/x-ssh-explorer/locals");
report(
  "GET /locals 报出桌面路径",
  locals.status === 200 && typeof locals.body.desktop === "string" && locals.body.desktop.length > 0,
  locals.body?.desktop,
);

// ── 2. 拉目录：中文名 / 子目录 / 二进制 / mtime
const pulled = await api("POST", "/x-ssh-explorer/pull", {
  connection: target.id,
  paths: [`${REMOTE}/中文 目录`],
  target: join(LOCAL, "dl"),
});
report("POST /pull 受理任务", pulled.status === 200 && typeof pulled.body?.job?.id === "string", pulled.body?.error ?? "");
const pullJob = await pollJob(pulled.body.job.id);
const gotDir = join(LOCAL, "dl", "中文 目录");
const a1 = join(gotDir, "a1.txt");
const b2 = join(gotDir, "sub", "b2.bin");
const a1Text = existsSync(a1) ? await readFile(a1, "utf8") : "";
const a1Stat = existsSync(a1) ? await stat(a1) : null;
const b2Bytes = existsSync(b2) ? await readFile(b2) : Buffer.alloc(0);
report("目录被还原成真实文件夹（中文名）", existsSync(a1) && existsSync(b2), gotDir);
report("文本内容一致（UTF-8）", a1Text === "hello-中文\n", JSON.stringify(a1Text));
report("二进制内容一致", b2Bytes.length === 5 && b2Bytes[0] === 0x42, Buffer.from(b2Bytes).toString("hex"));
const expected = Date.parse("2024-03-03T21:06:07Z") / 1000;
report(
  "mtime 被原样还原",
  a1Stat !== null && Math.abs(a1Stat.mtimeMs / 1000 - expected) < 2,
  a1Stat === null ? "缺文件" : new Date(a1Stat.mtimeMs).toISOString(),
);
report("任务终态 done", pullJob.state === "done", `${pullJob.state} ${pullJob.message ?? ""}`);

// ── 3. 拉单文件
const pullFile = await api("POST", "/x-ssh-explorer/pull", {
  connection: target.id,
  paths: [`${REMOTE}/中文 目录/a1.txt`],
  target: join(LOCAL, "dl"),
});
await pollJob(pullFile.body.job.id);
report("单文件落到落点目录", existsSync(join(LOCAL, "dl", "a1.txt")), join(LOCAL, "dl", "a1.txt"));

// ── 4. 同名不覆盖
const conflict = await api("POST", "/x-ssh-explorer/pull", {
  connection: target.id,
  paths: [`${REMOTE}/中文 目录/a1.txt`],
  target: join(LOCAL, "dl"),
});
const conflictJob = await pollJob(conflict.body.job.id);
report(
  "同名时不静默覆盖",
  conflictJob.items?.[0]?.state === "failed" && String(conflictJob.items[0].error).includes("已有同名"),
  String(conflictJob.items?.[0]?.error ?? ""),
);

// ── 5. 推目录 + 单文件
const pushRoot = join(LOCAL, "push", "中文 push 目录");
await mkdir(join(pushRoot, "inner"), { recursive: true });
await writeFile(join(pushRoot, "x.txt"), "pushed-中文\n");
await writeFile(join(pushRoot, "inner", "y.bin"), Buffer.from([0, 1, 2, 255, 254]));
await writeFile(join(LOCAL, "push", "single.txt"), "single-中文\n");
const pushed = await api("POST", "/x-ssh-explorer/push", {
  connection: target.id,
  dir: `${REMOTE}/up`,
  paths: [pushRoot, join(LOCAL, "push", "single.txt")],
});
report("POST /push 受理任务", pushed.status === 200, pushed.body?.error ?? "");
const pushJob = await pollJob(pushed.body.job.id);
const remoteX = await ssh(`cat "${REMOTE}/up/中文 push 目录/x.txt"`);
const remoteY = await ssh(`od -An -tx1 "${REMOTE}/up/中文 push 目录/inner/y.bin"`);
const remoteSingle = await ssh(`cat "${REMOTE}/up/single.txt"`);
report("目录推到远端（中文名）", remoteX.stdout === "pushed-中文\n", JSON.stringify(remoteX.stdout));
report("嵌套二进制一致", remoteY.stdout.replace(/\s+/g, " ").trim() === "00 01 02 ff fe", remoteY.stdout.trim());
report("单文件推到远端", remoteSingle.stdout === "single-中文\n", JSON.stringify(remoteSingle.stdout));
report(
  "push 任务终态 done",
  pushJob.state === "done",
  `${pushJob.state} ${JSON.stringify(pushJob.items.map((item) => [item.label, item.state, item.error]))}`,
);

// ── 6. 浏览器字节流兜底上传（没有本机路径桥时走这条）
const rawBytes = Buffer.from("raw-中文-body\n");
const uploadResponse = await fetch(
  `${base}/x-ssh-explorer/upload?connection=${encodeURIComponent(target.id)}&dir=${encodeURIComponent(`${REMOTE}/up`)}&relpath=${encodeURIComponent("raw/中文.bin")}&mtime=1709499967000`,
  { method: "POST", body: rawBytes },
);
const uploadBody = await uploadResponse.json();
const remoteRaw = await ssh(`cat "${REMOTE}/up/raw/中文.bin"`);
const remoteRawStat = await ssh(`stat -c %Y "${REMOTE}/up/raw/中文.bin"`);
report("POST /upload 写入远端", uploadBody.ok === true && remoteRaw.stdout === "raw-中文-body\n", JSON.stringify(uploadBody));
report("upload 保住 mtime", remoteRawStat.stdout.trim() === MTIME, remoteRawStat.stdout.trim());

// ── 7. 删除远端文件 / 文件夹（右键菜单、Del 键都走这条）
await ssh(`mkdir -p "${REMOTE}/del/中文目录/sub" && printf keep > "${REMOTE}/del/keep.txt" && printf gone > "${REMOTE}/del/gone.txt" && printf inner > "${REMOTE}/del/中文目录/sub/inner.txt"`);
const delOne = await api("POST", "/x-ssh-explorer/delete", {
  connection: target.id,
  paths: [`${REMOTE}/del/gone.txt`],
});
const goneCheck = await ssh(`test -e "${REMOTE}/del/gone.txt" && echo yes || echo no`);
const keepCheck = await ssh(`test -e "${REMOTE}/del/keep.txt" && echo yes || echo no`);
report(
  "POST /delete 删掉单个文件",
  delOne.status === 200 && delOne.body.ok === true && goneCheck.stdout.trim() === "no" && keepCheck.stdout.trim() === "yes",
  `${JSON.stringify(delOne.body)} / gone=${goneCheck.stdout.trim()} keep=${keepCheck.stdout.trim()}`,
);

const delDir = await api("POST", "/x-ssh-explorer/delete", {
  connection: target.id,
  paths: [`${REMOTE}/del/中文目录`],
});
const dirCheck = await ssh(`test -d "${REMOTE}/del/中文目录" && echo yes || echo no`);
report(
  "POST /delete 递归删掉中文名文件夹",
  delDir.status === 200 && delDir.body.ok === true && dirCheck.stdout.trim() === "no",
  `${JSON.stringify(delDir.body)} / 还在=${dirCheck.stdout.trim()}`,
);

const delRelative = await api("POST", "/x-ssh-explorer/delete", { connection: target.id, paths: ["relative/x"] });
report(
  "非绝对路径删除被逐条拒绝（不是整体失败）",
  delRelative.status === 200 && Array.isArray(delRelative.body.failed) && delRelative.body.failed.length === 1,
  JSON.stringify(delRelative.body),
);

const delEmpty = await api("POST", "/x-ssh-explorer/delete", { connection: target.id, paths: [] });
report("空 paths 删除返回 400", delEmpty.status === 400, String(delEmpty.status));

// 安全阀：根目录 / 家目录本身永远不能删（一次手滑就没了）
const delRoot = await api("POST", "/x-ssh-explorer/delete", { connection: target.id, paths: ["/"] });
report(
  "拒绝删除根目录",
  delRoot.status === 200 && delRoot.body.ok === false && String(delRoot.body.failed?.[0]?.error ?? "").includes("根目录"),
  JSON.stringify(delRoot.body),
);

const remoteHome = (await ssh("printf %s \"$HOME\"")).stdout.trim();
const delHome = await api("POST", "/x-ssh-explorer/delete", { connection: target.id, paths: [remoteHome] });
report(
  "拒绝删除家目录本身（传绝对路径也一样拦）",
  delHome.status === 200 && delHome.body.ok === false && String(delHome.body.failed?.[0]?.error ?? "").includes("家目录"),
  `${remoteHome} / ${JSON.stringify(delHome.body)}`,
);

// 幂等：多选里混进一条别人已经删掉的路径，不该算失败
const delGhost = await api("POST", "/x-ssh-explorer/delete", {
  connection: target.id,
  paths: [`${REMOTE}/del/never-existed.txt`],
});
report(
  "删不存在的路径算成功（幂等）",
  delGhost.status === 200 && delGhost.body.ok === true && delGhost.body.removed?.length === 1,
  JSON.stringify(delGhost.body),
);

// ── 7.5 新建 / 重命名（空白处右键新建、行右键重命名都走这两条）
await ssh(`mkdir -p "${REMOTE}/mut" && rm -rf "${REMOTE}/mut"/*`);

const madeFile = await api("POST", "/x-ssh-explorer/create", {
  connection: target.id,
  dir: `${REMOTE}/mut`,
  name: "新建 文件.txt",
  kind: "file",
});
const madeFileCheck = await ssh(`test -f "${REMOTE}/mut/新建 文件.txt" && wc -c < "${REMOTE}/mut/新建 文件.txt" || echo missing`);
report(
  "POST /create 新建空文件（名字带空格和中文）",
  madeFile.status === 200 && madeFile.body.ok === true && madeFileCheck.stdout.trim() === "0",
  `${JSON.stringify(madeFile.body)} / ${madeFileCheck.stdout.trim()}`,
);

const madeDir = await api("POST", "/x-ssh-explorer/create", {
  connection: target.id,
  dir: `${REMOTE}/mut`,
  name: "新目录",
  kind: "dir",
});
const madeDirCheck = await ssh(`test -d "${REMOTE}/mut/新目录" && echo dir || echo no`);
report(
  "POST /create 新建文件夹",
  madeDir.status === 200 && madeDir.body.ok === true && madeDirCheck.stdout.trim() === "dir",
  `${JSON.stringify(madeDir.body)} / ${madeDirCheck.stdout.trim()}`,
);

const dupCreate = await api("POST", "/x-ssh-explorer/create", {
  connection: target.id,
  dir: `${REMOTE}/mut`,
  name: "新目录",
  kind: "dir",
});
report(
  "同名新建被拒（409，不覆盖）",
  dupCreate.status === 409 && dupCreate.body.ok === false && String(dupCreate.body.error).includes("已存在"),
  `${dupCreate.status} ${JSON.stringify(dupCreate.body)}`,
);

const badName = await api("POST", "/x-ssh-explorer/create", {
  connection: target.id,
  dir: `${REMOTE}/mut`,
  name: "../跳出目录",
});
report("名字带路径分隔符被拒（400）", badName.status === 400, `${badName.status} ${String(badName.body.error)}`);

const createBadDir = await api("POST", "/x-ssh-explorer/create", {
  connection: target.id,
  dir: "relative/dir",
  name: "x",
});
report("新建目录不是远端绝对路径被拒（400）", createBadDir.status === 400, String(createBadDir.body.error));

// 反斜杠在 Windows 上也是分隔符，必须一起挡掉（Python 里那个字符串容易写错）
const badBackslash = await api("POST", "/x-ssh-explorer/create", {
  connection: target.id,
  dir: `${REMOTE}/mut`,
  name: "a\\b.txt",
});
report(
  "名字带反斜杠也被拒（400）",
  badBackslash.status === 400 && String(badBackslash.body.error).includes("分隔符"),
  `${badBackslash.status} ${String(badBackslash.body.error)}`,
);

const renamed = await api("POST", "/x-ssh-explorer/rename", {
  connection: target.id,
  path: `${REMOTE}/mut/新建 文件.txt`,
  name: "改名后.txt",
});
const renameCheck = await ssh(
  `test -f "${REMOTE}/mut/改名后.txt" && test ! -e "${REMOTE}/mut/新建 文件.txt" && echo ok || echo bad`,
);
report(
  "POST /rename 改文件名（旧名消失、新名出现）",
  renamed.status === 200 && renamed.body.ok === true && renameCheck.stdout.trim() === "ok",
  `${JSON.stringify(renamed.body)} / ${renameCheck.stdout.trim()}`,
);

await ssh(`mkdir -p "${REMOTE}/mut/待改名/sub" && printf inner > "${REMOTE}/mut/待改名/sub/inner.txt"`);
const renamedDir = await api("POST", "/x-ssh-explorer/rename", {
  connection: target.id,
  path: `${REMOTE}/mut/待改名`,
  name: "改好了",
});
const renamedDirCheck = await ssh(`cat "${REMOTE}/mut/改好了/sub/inner.txt"`);
report(
  "POST /rename 改文件夹名（内容跟着走）",
  renamedDir.status === 200 && renamedDir.body.ok === true && renamedDirCheck.stdout.trim() === "inner",
  `${JSON.stringify(renamedDir.body)} / ${renamedDirCheck.stdout.trim()}`,
);

const clash = await api("POST", "/x-ssh-explorer/rename", {
  connection: target.id,
  path: `${REMOTE}/mut/改名后.txt`,
  name: "改好了",
});
report(
  "重命名撞上同名被拒（409）",
  clash.status === 409 && String(clash.body.error).includes("已存在"),
  `${clash.status} ${JSON.stringify(clash.body)}`,
);

const renameRoot = await api("POST", "/x-ssh-explorer/rename", {
  connection: target.id,
  path: "/",
  name: "x",
});
report(
  "拒绝重命名根目录",
  renameRoot.status === 400 && String(renameRoot.body.error).includes("根目录"),
  `${renameRoot.status} ${JSON.stringify(renameRoot.body)}`,
);

const renameGhost = await api("POST", "/x-ssh-explorer/rename", {
  connection: target.id,
  path: `${REMOTE}/mut/根本没有.txt`,
  name: "x.txt",
});
report(
  "重命名不存在的东西报错",
  renameGhost.status === 400 && String(renameGhost.body.error).includes("不在了"),
  `${renameGhost.status} ${JSON.stringify(renameGhost.body)}`,
);

// ── 8. 取消：大文件传到一半停掉
await ssh(`dd if=/dev/zero of=${REMOTE}/big.bin bs=1M count=180 status=none`);
const big = await api("POST", "/x-ssh-explorer/pull", {
  connection: target.id,
  paths: [`${REMOTE}/big.bin`],
  target: join(LOCAL, "big"),
});
const bigId = big.body.job.id;
await new Promise((done) => setTimeout(done, 1200));
const cancelled = await api("POST", "/x-ssh-explorer/job", { id: bigId, cancel: true });
report("取消请求被受理", cancelled.status === 200, `${cancelled.body?.job?.state}`);
const bigFinal = await pollJob(bigId, { timeoutMs: 30000 });
const leftovers = existsSync(join(LOCAL, "big")) ? await readdir(join(LOCAL, "big")) : [];
report(
  "取消后状态 cancelled 且不留半成品",
  bigFinal.state === "cancelled" && !leftovers.some((name) => name.endsWith(".re-dl-tmp")),
  `${bigFinal.state} / ${leftovers.join(",")}`,
);

// ── 9. 参数校验
const badConn = await api("POST", "/x-ssh-explorer/pull", { connection: "nope", paths: ["/tmp"], target: "desktop" });
const badDir = await api("POST", "/x-ssh-explorer/push", { connection: target.id, dir: "relative/path", paths: [LOCAL] });
const badTarget = await api("POST", "/x-ssh-explorer/pull", { connection: target.id, paths: ["/tmp/x"], target: "relative" });
report("未知连接返回 404", badConn.status === 404, String(badConn.status));
report("非绝对远端目录被拒", badDir.status === 400, String(badDir.body?.error));
report("非法落点被拒", badTarget.status === 400, String(badTarget.body?.error));

server.close();
console.log("");
console.log(failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
