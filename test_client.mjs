/**
 * 客户端半边的渲染冒烟测试。
 *
 * 客户端模块在浏览器里跑，Node 直接 import 会因为没有 `window.__ModuleLoader__`
 * 和 `require("react")` 而失败。这里搭一套最小替身：
 *
 *   - 假的 `window.__ModuleLoader__.load()` 接住模块定义
 *   - 假的 `require()`，`"react"` 返回一个迷你 React（自己的 hook 运行时）
 *   - 假的插件 ctx，只实现 `slots.inject` / `slots.register`
 *
 * 能验证的东西：模块形状（name/inject/apply）、两处槽位注册的 options 是否正确、
 * 图标组件的 props 处理，以及 **面板组件在多种状态下渲染不抛异常**。
 *
 * 验证不了的：真实的 React 协调、真实样式、真实 fetch（浏览器行为）。
 *
 * 用法：node test_client.mjs
 */

import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────── 迷你 React

/** 收集一次渲染期间产生的整棵元素树的纯文本。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object" && node.children) return textOf(node.children);
  return "";
}

/**
 * 递归展开函数组件。
 *
 * 真正的 React 会调用函数组件并协调其返回的子树；这个替身原本只把
 * `<ConnectionForm />` 记成一个 `{type: f, props}` 对象，导致嵌在里面的字段
 * 全被漏掉。这里手动调用函数类型的元素，把返回的子树继续展开。
 *
 * hook 槽位是全局顺序分配的，嵌套组件会排在父组件之后 —— 只要组件树结构
 * 在两次渲染之间不变，槽位就是稳定的，所以没问题。
 */
function expand(node) {
  if (node === null || node === undefined || node === false) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== "object") return node;
  if (typeof node.type === "function") {
    // 真 React 会把子节点合并进 props.children，这个替身把 children 放在元素
    // 外层，所以调用函数组件时必须手动合回去，否则组件的子内容会整体丢失。
    return expand(node.type({ ...node.props, children: node.children }));
  }
  return { ...node, children: expand(node.children) };
}

/** 元素树里所有元素的 type 名，用于断言某块 UI 出现了。 */
function typesOf(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) typesOf(child, out);
    return out;
  }
  out.push(typeof node.type === "string" ? node.type : node.type?.name ?? "?");
  typesOf(node.children, out);
  return out;
}

/** 元素树里所有 input 的 placeholder，用于断言「留空则…」这类只出现在占位符里的提示。 */
function placeholdersOf(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) placeholdersOf(child, out);
    return out;
  }
  if (node.type === "input" && node.props && typeof node.props.placeholder === "string") {
    out.push(node.props.placeholder);
  }
  placeholdersOf(node.children, out);
  return out;
}

/** 收集一个 <select> 里所有 <option> 的 value（会穿过 <optgroup>）。 */
function optionValues(selectNode) {
  const out = [];
  const flatten = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) flatten(item);
      return;
    }
    if (node.type === "option" && node.props) {
      out.push(String(node.props.value ?? ""));
      return;
    }
    // optgroup（以及任何包装节点）继续往里挖
    if (node.props && node.children !== undefined) flatten(node.children);
  };
  flatten(selectNode?.children);
  return out;
}

/** 收集一个 <select> 里的 <optgroup> 标签，用来验证分组渲染。 */
function optionGroups(selectNode) {
  const out = [];
  const flatten = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) flatten(item);
      return;
    }
    if (node.type === "optgroup" && node.props) out.push(String(node.props.label ?? ""));
    if (node.props && node.children !== undefined) flatten(node.children);
  };
  flatten(selectNode?.children);
  return out;
}

/** 极简 hook 运行时：按调用顺序分配槽位，允许在两次渲染之间改写状态。 */
function createHookRuntime() {
  let states = [];
  let index = 0;
  return {
    reset() {
      index = 0;
    },
    clear() {
      states = [];
      index = 0;
    },
    useState(initial) {
      const slot = index++;
      if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
      const setter = (next) => {
        states[slot] = typeof next === "function" ? next(states[slot]) : next;
      };
      return [states[slot], setter];
    },
    useCallback(fn) {
      index++;
      return fn;
    },
    useEffect() {
      index++;
    },
    useRef(initial) {
      const slot = index++;
      if (!(slot in states)) states[slot] = { current: initial === undefined ? null : initial };
      return states[slot];
    },
    /** 测试用：直接改写某个槽位的状态值。 */
    set(slot, value) {
      states[slot] = value;
    },
    peek(slot) {
      return states[slot];
    },
  };
}

const runtime = createHookRuntime();

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: "Fragment",
  useState: (...args) => runtime.useState(...args),
  useCallback: (...args) => runtime.useCallback(...args),
  useEffect: (...args) => runtime.useEffect(...args),
  useRef: (...args) => runtime.useRef(...args),
};

// ─────────────────────────────────────────────── 加载模块

let definition = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (mod) => {
      definition = mod;
    },
  },
};

await import("./plugin/lib/client.js");

let failures = 0;
function report(label, condition, detail) {
  if (condition) console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

report("模块注册了 load()", definition !== null);
report("模块 id 正确", definition?.id === "dsh-ssh-explorer", `id=${definition?.id}`);

const clientExports = definition.factory((specifier) => {
  if (specifier === "react") return react;
  throw new Error(`意外的 require("${specifier}")`);
});

report("导出 name", clientExports.name === "ssh-explorer", `name=${clientExports.name}`);
report(
  "导出 inject = ['slots']",
  Array.isArray(clientExports.inject) && clientExports.inject.length === 1 && clientExports.inject[0] === "slots",
  JSON.stringify(clientExports.inject),
);
report("导出 apply 是函数", typeof clientExports.apply === "function");

// ── package.json 的 dsh.client 与 export 路径要对得上

const pkg = JSON.parse(readFileSync(new URL("./plugin/package.json", import.meta.url), "utf8"));
report("package.json name 与模块 id 一致", pkg.name === definition.id, `${pkg.name} vs ${definition.id}`);
report("exports['./client'] 指向 lib/client.js", pkg.exports["./client"] === "./lib/client.js");
report("dsh.client.platform = web", pkg.dsh?.client?.platform === "web");
report("dsh.client.inject 只声明 sidebar", JSON.stringify(pkg.dsh?.client?.inject) === '["@deepseek-ai/dsh-client-ui-sidebar"]', JSON.stringify(pkg.dsh?.client?.inject));

// ── 注册行为

const registrations = [];
const fakeCtx = {
  slots: {
    inject(name, factory) {
      registrations.push({ slot: name, result: factory() });
    },
    register(options, component) {
      return { options, component, dispose() {} };
    },
  },
};

clientExports.apply(fakeCtx);

report("注册了两处槽位", registrations.length === 2, registrations.map((r) => r.slot).join(", "));

const panelEntry = registrations.find((r) => r.slot === "sidebar.panellist");
const mainEntry = registrations.find((r) => r.slot === "main");

report("活动栏条目注册到 sidebar.panellist", Boolean(panelEntry));
report("活动栏 id 正确", panelEntry?.result.options.id === "ssh-explorer", `id=${panelEntry?.result.options.id}`);
report("活动栏有 order", typeof panelEntry?.result.options.order === "number", `order=${panelEntry?.result.options.order}`);
report("活动栏 label 是字符串", typeof panelEntry?.result.options.label === "string", panelEntry?.result.options.label);
report("活动栏组件是函数", typeof panelEntry?.result.component === "function");
report("主面板注册到 main", Boolean(mainEntry));
report("主面板 key 与活动栏 id 相同", mainEntry?.result.options.key === panelEntry?.result.options.id, `${mainEntry?.result.options.key} vs ${panelEntry?.result.options.id}`);
report("主面板组件是函数", typeof mainEntry?.result.component === "function");

// ── 图标组件

const icon = clientExports.ExplorerIcon({ size: 18, active: true });
report("图标组件返回元素", icon && icon.type === "svg", `type=${icon?.type}`);
report("图标遵守 size prop", icon?.props.width === 18 && icon?.props.height === 18, `w=${icon?.props.width}`);
const iconDefault = clientExports.ExplorerIcon({});
report("图标无 size 时有默认值", iconDefault?.props.width === 18, `w=${iconDefault?.props.width}`);

// ── 面板渲染：逐个状态

const ExplorerPanel = clientExports.ExplorerPanel;

/** 渲染一次面板，返回元素树。 */
function render() {
  runtime.reset();
  return expand(ExplorerPanel({}));
}

// 状态槽位：0=state 1=preview 2=showForm 3=info（见 client.js 里的 hook 顺序）
runtime.clear();
let tree = render();
report("初始渲染不抛异常（loading 分支）", Boolean(tree), `text="${textOf(tree).slice(0, 40)}"`);
report("初始渲染显示载入中", textOf(tree).includes("载入中"), `"${textOf(tree).slice(0, 40)}"`);

runtime.set(0, {
  loading: true,
  error: "连接超时：测试用错误",
  connections: [],
  sshAvailable: true,
  connectionId: "",
  path: "",
  parent: null,
  entries: [],
  listing: false,
});
tree = render();
report("错误状态渲染错误横幅", textOf(tree).includes("连接超时"), `"${textOf(tree).slice(0, 60)}"`);

runtime.set(0, {
  loading: false,
  error: null,
  connections: [],
  sshAvailable: false,
  connectionId: "",
  path: "",
  parent: null,
  entries: [],
  listing: false,
});
tree = render();
report("没有连接时提示建连接", textOf(tree).includes("ssh 可执行文件"), `"${textOf(tree).slice(0, 60)}"`);

const loadedState = {
  loading: false,
  error: null,
  connections: [
    { id: "ssh-config:ubuntu", name: "ubuntu", host: "192.168.111.129", user: "admin", source: "ssh-config", readOnly: true, authType: "auto", hasPassword: false },
    { id: "user:abc", name: "自建机", host: "10.0.0.5", user: "root", source: "user", authType: "password", hasPassword: true },
  ],
  sshAvailable: true,
  connectionId: "ssh-config:ubuntu",
  path: "/home/admin",
  parent: "/home",
  entries: [
    { name: "桌面", dir: true, size: 4096, mtime: 1760000000, mode: "755", link: false },
    { name: "notes.txt", dir: false, size: 1234, mtime: 1760000000, mode: "644", link: false },
    { name: "link", dir: false, size: 11, mtime: 1760000000, mode: "777", link: true },
  ],
  listing: false,
};
runtime.set(0, loadedState);
runtime.set(3, { ok: true, hostname: "myubuntu", os: "Linux-6.8.0-138-generic-x86_64" });
runtime.set(1, null);
runtime.reset();
tree = render();
const loadedText = textOf(tree);
const loadedTypes = typesOf(tree);

report("列出目录时渲染条目", loadedText.includes("notes.txt") && loadedText.includes("桌面"), "找到文件名");
report("显示远端主机名", loadedText.includes("myubuntu"), "找到 hostname");
report("显示路径", loadedText.includes("/home/admin"), "找到路径");
report("目录行带 ▸、文件行不带", loadedText.includes("▸"), "找到目录标记");
report("符号链接有标记", loadedText.includes("↗"), "找到链接标记");
report("有 select 下拉", loadedTypes.includes("select"), `types=${[...new Set(loadedTypes)].slice(0, 8).join(",")}`);
report("有面包屑（多级路径）", loadedText.includes("home") && loadedText.includes("admin"), "面包屑分段");
report("空预览提示", loadedText.includes("点左侧文件名"), `"${loadedText.slice(-40)}"`);
report("渲染了行分隔的 3 个条目", loadedTypes.filter((t) => t === "div").length >= 5, `div 数=${loadedTypes.filter((t) => t === "div").length}`);

// 预览：二进制
runtime.set(1, { ok: true, binary: true, size: 2048, path: "/home/admin/x.bin" });
runtime.reset();
tree = render();
report("二进制文件提示不可预览", textOf(tree).includes("二进制文件"), `"${textOf(tree).slice(-60)}"`);

// 预览：文本（带截断）
runtime.set(1, { ok: true, binary: false, size: 999, path: "/home/admin/notes.txt", truncated: true, text: "hello from ubuntu\n" });
runtime.reset();
tree = render();
const previewText = textOf(tree);
report("文本预览显示内容", previewText.includes("hello from ubuntu"), "找到正文");
report("截断有提示", previewText.includes("已截断"), "找到截断标记");

// 预览：报错
runtime.set(1, { ok: false, loading: false, error: "权限不足" });
runtime.reset();
tree = render();
report("预览失败显示错误", textOf(tree).includes("权限不足"), "找到错误文案");

// ─────────────────────────────────────────── 连接操作栏（含每连接独立密码）

// 自建连接：编辑 + 删除 + 改密码，且显示已存密码
runtime.set(0, { ...loadedState, connectionId: "user:abc" });
runtime.set(1, null);
runtime.set(5, null);
runtime.reset();
tree = render();
let opsText = textOf(tree);
report("自建连接显示「编辑」与「删除」", opsText.includes("编辑") && opsText.includes("删除"), "两个按钮都在");
report("自建连接显示改密码入口", opsText.includes("🔑 改密码"), "找到 🔑 改密码");
report("已有密码时标注已存密码", opsText.includes("已存密码"), "找到「已存密码」");
report("认证方式显示为「只用密码」", opsText.includes("认证：只用密码"), "找到认证方式");

// 只读连接（~/.ssh/config）：有设密码入口，不能改定义，但可以删（只从清单隐藏）
runtime.set(0, loadedState);
runtime.reset();
tree = render();
opsText = textOf(tree);
report(
  "ssh-config 连接不显示「编辑」按钮（改不了它的定义）",
  !buttonByText(tree, "编辑"),
  // 注意：不能用 opsText.includes("编辑") —— 预览区的提示语里也有「编辑」二字。
  `编辑按钮=${Boolean(buttonByText(tree, "编辑"))}`,
);
report(
  "ssh-config 连接也能删（删 = 从清单隐藏，不动配置文件）",
  Boolean(buttonByText(tree, "删除")) && opsText.includes("来自 ~/.ssh/config"),
  `删除按钮=${Boolean(buttonByText(tree, "删除"))}`,
);
report(
  "ssh-config 连接也能设密码（每连接独立）",
  opsText.includes("🔑 设密码") && opsText.includes("来自 ~/.ssh/config"),
  "找到 🔑 设密码",
);
report("无密码时不标注已存密码", !opsText.includes("已存密码"), "没有已存密码标记");
report("认证方式显示为自动", opsText.includes("自动（先试密钥，再试密码）"), "找到自动");

// ─────────────────────────────────────────── 口令设置弹层

runtime.set(5, loadedState.connections[0]);
runtime.set(1, null);
runtime.reset();
tree = render();
let secretText = textOf(tree);
report(
  "口令弹层标出目标主机",
  secretText.includes("为「ubuntu」设置密码") && secretText.includes("admin@192.168.111.129"),
  "找到目标主机",
);
report("口令弹层说明加密方式", secretText.includes("只有当前 Windows 账户能解开"), "找到 DPAPI 说明");
report("口令弹层有保存按钮", secretText.includes("保存密码"), "找到保存密码");
report("未存密码时不显示清除按钮", !secretText.includes("清除密码"), "没有清除密码");

runtime.set(5, loadedState.connections[1]);
runtime.reset();
tree = render();
secretText = textOf(tree);
report("已存密码时提供清除按钮", secretText.includes("清除密码"), "找到清除密码");
report("口令弹层提示改密码", secretText.includes("为「自建机」设置密码"), "找到自建机");

// ─────────────────────────────────────────── 表单：新建 vs 编辑

runtime.set(5, null);
runtime.set(4, null);
runtime.set(2, true);
runtime.set(1, null);
runtime.reset();
tree = render();
const formText = textOf(tree);
const formTypes = typesOf(tree);
report("表单渲染出全部字段", ["名称", "主机", "端口", "用户名", "私钥"].every((k) => formText.includes(k)), "五个字段都在");
report("表单新增认证方式与密码", formText.includes("认证方式") && formText.includes("密码"), "找到认证方式与密码");
report("认证方式是下拉框", formTypes.includes("select"), `types=${formTypes.join(",")}`);
report("新建时标题是「新建连接」", formText.includes("新建连接") && formText.includes("保存连接"), "新建标题正确");
report("表单提示 DPAPI 加密", formText.includes("DPAPI 加密"), "找到加密说明");

// 编辑已有连接：字段被预填，按钮变「保存修改」
runtime.set(4, loadedState.connections[1]);
runtime.set(2, true);
runtime.reset();
tree = render();
const editText = textOf(tree);
report("编辑时标题带连接名", editText.includes("编辑「自建机」"), "找到编辑标题");
report("编辑时按钮是「保存修改」", editText.includes("保存修改"), "找到保存修改");
const editPlaceholders = placeholdersOf(tree);
report(
  "编辑时密码框提示留空不改",
  editPlaceholders.includes("已保存，留空则不改动"),
  `placeholders=${JSON.stringify(editPlaceholders)}`,
);

// 认证方式改成「只用密钥」时，私钥提示语随之变化
runtime.set(4, { ...loadedState.connections[1], authType: "key", hasPassword: false });
runtime.reset();
tree = render();
report("认证方式影响私钥提示", placeholdersOf(tree).includes("留空用 ~/.ssh/id_ed25519"), "找到密钥提示语");

// ─────────────────────────────────────────── 认证失败时就地提示输口令

// 场景甲：没存口令 + 报「Permission denied」→ 必须出现内联输入框
runtime.set(2, false);
runtime.set(4, null);
runtime.set(5, null);
runtime.reset();
runtime.set(0, {
  ...loadedState,
  error: "admin@192.168.111.129: Permission denied (publickey,password).",
  connectionId: "ssh-config:ubuntu",
});
tree = render();
const authText = textOf(tree);
const authPlaceholders = placeholdersOf(tree);
report("认证失败时提示输口令", authText.includes("这台主机要口令"), `"${authText.slice(0, 80)}"`);
report(
  "提示里说明会加密保存",
  authText.includes("加密保存") && authText.includes("以后自动用"),
  "找到「加密保存 / 以后自动用」",
);
report("有口令输入框", authPlaceholders.includes("登录密码或密钥口令"), `placeholders=${JSON.stringify(authPlaceholders)}`);
report("有「保存口令并重试」按钮", authText.includes("保存口令并重试"), "找到按钮");

// 场景乙：同一条连接已经存了口令 → 不再打扰（避免每次报错都弹输入框）
runtime.set(0, {
  ...loadedState,
  error: "admin@192.168.111.129: Permission denied (publickey,password).",
  connectionId: "user:abc",
});
runtime.reset();
tree = render();
report("已存口令的连接不再提示", !textOf(tree).includes("这台主机要口令"), "未出现提示条");

// 场景丙：非认证类报错（比如目录不存在）→ 不该弹口令框
runtime.set(0, { ...loadedState, error: "[Errno 2] No such file or directory: '/nope'", connectionId: "ssh-config:ubuntu" });
runtime.reset();
tree = render();
report("其它报错不弹口令框", !textOf(tree).includes("这台主机要口令"), "未出现提示条");

// ─────────────────────────────────────────── AI 对话页

/** 深度遍历元素树。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!node.type) return;
  visit(node);
  walk(node.children, visit);
}

/** 按文案找第一个 button。 */
function buttonByText(source, label) {
  let hit = null;
  walk(source, (node) => {
    if (hit === null && node.type === "button" && textOf(node).includes(label)) hit = node;
  });
  return hit;
}

// 切页靠 view 槽位（ExplorerPanel 的第 9 个 state = 槽位 8）
//
// SLOT = ExplorerPanel 一共占用的 hook 数，ChatPanel 的槽位从这里开始往后排。
// 现状：state 0..8、可拉伸宽度 9..10（listWidth / chatWidth）、
//       宽度持久化 useCallback/useEffect 11..19、编辑草稿 20、
//       拖拽传输（落点 / 本机目录 / 任务表 / 抽屉 / 拖入高亮 / 拖出记录 / 5 个 effect）21..31、
//       连接管理（管理浮层开关 / 待确认删除的连接）32..33、
//       选中与删除（选中集合 / 右键菜单 / 待确认删除）34..36、
//       新建与重命名（「输入名字」浮层）37、
//       两个 effect 38..39（Del 键、换目录清选中）
//       → 共 40 个。
// **给 ExplorerPanel 加 hook 必须同步改这个数，否则下面所有槽位整体错位。**
const SLOT = 40;
const LIST_WIDTH_SLOT = 9;
const CHAT_WIDTH_SLOT = 10;
const EDIT_DRAFT_SLOT = 20;
// ⚠️ 对话面板现在停在文件页右边，文件页照常渲染 → 列表里每个文件行都是一个
// `Row` 组件，各占 1 个 hook，会排在 ChatPanel 前面。所以这一节把 entries 钉成空，
// 让 ChatPanel 从 SLOT 开始排；否则 CHAT_INPUT 得跟着行数走。
const CHAT_INPUT = SLOT + 1;
// ChatPanel 内部槽位（相对 SLOT）：0 messages、1 input、2 busy、3 error、4 steps、
// 5 model、6 模型清单、7 提供商分组、8 网关其余模型、9 选中的模型、10 保存提示、
// 11 滚动 effect、12 send、13 拉清单 effect、14 pickModel。
// 运行时 useEffect 是空操作，所以测试直接往 6 / 7 / 8 / 9 槽位写值。
const CHAT_MODELS_SLOT = SLOT + 6;
const CHAT_GROUPS_SLOT = SLOT + 7;
const CHAT_EXTRA_SLOT = SLOT + 8;
const CHAT_CHOSEN_SLOT = SLOT + 9;
runtime.clear();
runtime.set(0, { ...loadedState, entries: [], connectionId: "ssh-config:ubuntu" });
runtime.set(1, null);
runtime.set(2, false);
runtime.set(4, null);
runtime.set(5, null);
runtime.set(8, "chat");
tree = render();

const chatTypes = [...new Set(typesOf(tree))];
if (process.env.DBG) {
  console.log("[dbg] text =", JSON.stringify(textOf(tree)));
  for (let i = 0; i < 24; i += 1) {
    console.log(`[dbg] slot${i} =`, JSON.stringify(runtime.peek(i))?.slice(0, 90));
  }
}
report("对话页渲染出输入框", typesOf(tree).includes("textarea"), `types=${chatTypes.join(",")}`);
report("对话面板有关闭按钮", Boolean(buttonByText(tree, "✕")), "找到关闭按钮");
report("对话页标出「✦ AI 对话」", textOf(tree).includes("✦ AI 对话"), "页签标签正确");
report("对话页显示当前连接名", textOf(tree).includes("ubuntu"), "标了连接");
report("对话页有开场提示", textOf(tree).includes("跟它说你想在远端做什么"), "开场文案在");
report("对话页有发送按钮", Boolean(buttonByText(tree, "发送")), "找到发送按钮");
report("空输入时发送按钮禁用", buttonByText(tree, "发送")?.props.disabled === true, "disabled=true");
// 现在是右侧停靠面板，文件页原样留在左边（以前是整页替换，工具栏会消失）。
report("对话面板不整页替换（文件工具栏仍在）", textOf(tree).includes("⟳ 刷新"), "工具栏保留");

// ── 可拉伸：两条分隔条 + 宽度取自 hook 槽位
const separators = [];
walk(tree, (node) => {
  if (node.props && node.props.role === "separator") separators.push(node);
});
report("渲染出两条竖直分隔条", separators.length === 2, `found=${separators.length}`);
report(
  "分隔条用 col-resize 光标（暗示可拖）",
  separators.every((node) => node.props.style && node.props.style.cursor === "col-resize"),
  separators.map((node) => node.props.style?.cursor).join(","),
);

runtime.set(LIST_WIDTH_SLOT, 640);
runtime.set(CHAT_WIDTH_SLOT, 512);
runtime.reset();
tree = render();
const widthOf = (style) => style?.width;
const listPane = (() => {
  let found = null;
  walk(tree, (node) => {
    if (found === null && node.props && node.props.style && widthOf(node.props.style) !== undefined) {
      found = node;
    }
  });
  return found;
})();
report("文件列表宽度来自 hook 槽位", widthOf(listPane?.props.style) === 640, `width=${widthOf(listPane?.props.style)}`);
const widths = [];
walk(tree, (node) => {
  if (node.props && node.props.style && typeof node.props.style.width === "number") {
    widths.push(node.props.style.width);
  }
});
report("对话面板宽度来自 hook 槽位", widths.includes(512), `widths=${JSON.stringify(widths.slice(0, 6))}`);

// ── 拖动方向：分隔条＝面板边界，边界往哪边移、面板就往哪边长（直接操作语义）
// 曾经反过一次：拖右边那条要让对话变大得往右拖，很别扭。这里钉死方向防回归。
{
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  const listeners = new Map();
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const list = listeners.get(type) ?? [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
  };
  globalThis.document = { body: { style: {} } };
  const fire = (type, event) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
  };
  const drag = (separator, fromX, toX) => {
    separator.props.onMouseDown({ button: 0, clientX: fromX, preventDefault() {} });
    fire("mousemove", { clientX: toX });
    fire("mouseup", {});
  };

  runtime.set(LIST_WIDTH_SLOT, 480);
  runtime.set(CHAT_WIDTH_SLOT, 420);
  runtime.reset();
  const dragTree = render();
  const dragSeps = [];
  walk(dragTree, (node) => {
    if (node.props && node.props.role === "separator") dragSeps.push(node);
  });

  drag(dragSeps[0], 1000, 1060); // 列表在左：往右拖 60
  report(
    "列表条往右拖 → 列表变宽（直接操作）",
    runtime.peek(LIST_WIDTH_SLOT) === 540,
    `width=${runtime.peek(LIST_WIDTH_SLOT)}`,
  );

  drag(dragSeps[1], 1000, 920); // 对话在右：往左拖 80
  report(
    "对话条往左拖 → 对话变宽（直接操作）",
    runtime.peek(CHAT_WIDTH_SLOT) === 500,
    `width=${runtime.peek(CHAT_WIDTH_SLOT)}`,
  );

  drag(dragSeps[0], 1000, 900); // 反向：往左拖 100 → 列表变窄
  report(
    "列表条往左拖 → 列表变窄",
    runtime.peek(LIST_WIDTH_SLOT) === 380,
    `width=${runtime.peek(LIST_WIDTH_SLOT)}`,
  );

  drag(dragSeps[1], 1000, 1090); // 反向：往右拖 90 → 对话变窄
  report(
    "对话条往右拖 → 对话变窄",
    runtime.peek(CHAT_WIDTH_SLOT) === 330,
    `width=${runtime.peek(CHAT_WIDTH_SLOT)}`,
  );

  drag(dragSeps[1], 1000, 2000); // 拖过头 → 夹到下限
  report(
    "拖过头夹在下限（对话最小 280）",
    runtime.peek(CHAT_WIDTH_SLOT) === 280,
    `width=${runtime.peek(CHAT_WIDTH_SLOT)}`,
  );

  globalThis.window = savedWindow;
  globalThis.document = savedDocument;
}

runtime.set(LIST_WIDTH_SLOT, 480);
runtime.set(CHAT_WIDTH_SLOT, 420);
runtime.reset();
tree = render();

// 有输入 → 发送按钮启用（input = SLOT + 1）
runtime.set(CHAT_INPUT, "在 /home/admin/demo 下写个 hello.py 并跑一遍");
runtime.reset();
tree = render();
const textarea = (() => {
  let found = null;
  walk(tree, (node) => {
    if (found === null && node.type === "textarea") found = node;
  });
  return found;
})();
report("有输入时发送按钮启用", buttonByText(tree, "发送")?.props.disabled === false, "disabled=false");
report("输入内容进了文本框 value", textarea?.props.value === "在 /home/admin/demo 下写个 hello.py 并跑一遍", `value=${textarea?.props.value}`);

// 点发送 → 走 SSE 流（跟宿主 chatStream 的事件序列一致）→ 助手消息 + 工具卡 + 思考块
const calls = [];

/** 造一个假的 SSE Response；frames 是 [事件名, 载荷] 的数组。 */
function sseResponse(frames) {
  const text = frames.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  let sent = false;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "text/event-stream; charset=utf-8" },
    body: {
      getReader() {
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(text) };
          },
        };
      },
    },
  };
}

globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
  return sseResponse([
    ["round", { round: 1, max: 10 }],
    ["thinking", { text: "先确认文件在不在" }],
    ["thinking-done", { text: "先确认文件在不在" }],
    ["tool-start", { name: "ssh_exec", args: { command: "python3 hello.py" } }],
    ["tool", { name: "ssh_exec", args: { command: "python3 hello.py" }, output: "hello\n" }],
    ["reply", { text: "```bash\necho hi\n```\n\n写好了，输出是 " }],
    ["reply", { text: "hello" }],
    [
      "done",
      {
        ok: true,
        reply: "```bash\necho hi\n```\n\n写好了，输出是 hello",
        model: "cn:deepseek-v4.1-flash",
        reasoning: "先确认文件在不在",
        steps: [{ name: "ssh_exec", args: { command: "python3 hello.py" }, output: "hello\n" }],
        usage: null,
      },
    ],
  ]);
};

buttonByText(tree, "发送").props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
runtime.reset();
tree = render();

report("发送时 POST 到 /chat", calls.length === 1 && calls[0].url.endsWith("/chat"), calls[0]?.url ?? "未发起请求");
report(
  "请求体带上 connectionId 与历史",
  calls[0]?.body?.connectionId === "ssh-config:ubuntu" && calls[0]?.body?.messages?.length === 1,
  JSON.stringify(calls[0]?.body?.messages ?? null),
);
report("请求体带上了当前目录", calls[0]?.body?.path === "/home/admin", `path=${calls[0]?.body?.path}`);
report("请求体要了流式（stream:true）", calls[0]?.body?.stream === true, `stream=${calls[0]?.body?.stream}`);
report("助手回复渲染成气泡", textOf(tree).includes("写好了，输出是 hello"), "气泡在");
report("工具调用渲染成命令行", textOf(tree).includes("$ python3 hello.py"), "工具轨迹在");
report("工具输出渲染出来", textOf(tree).includes("hello"), "输出可见");
report("用户消息留在历史里", textOf(tree).includes("hello.py"), "用户消息在");

// 思考过程：默认折叠，抬头上写明「已深度思考」
report("思考过程有折叠抬头", textOf(tree).includes("已深度思考"), "思考块在");
report(
  "思考正文默认收起（不挂在树上）",
  !textOf(tree).includes("先确认文件在不在"),
  "默认收起",
);
// markdown：围栏代码块渲染成 pre，并且不再把 ``` 原样吐出来
const mdPre = (() => {
  let found = null;
  walk(tree, (node) => {
    if (found === null && node.type === "pre" && String(node.children?.[0] ?? "").includes("echo hi")) {
      found = node;
    }
  });
  return found;
})();
report("markdown 代码块渲染成 pre", mdPre !== null, mdPre ? "找到代码块" : "没找到");
report("代码块不再露出围栏标记", !textOf(tree).includes("```"), "围栏已吃掉");


// ── 模型选择器 ────────────────────────────────────────────
// 运行时 useEffect 是空操作，所以直接往 ChatPanel 的「清单 / 分组 / 选中」槽位写值。
// 分组 = 用户在 DSH「设置 → 模型」里配过的提供商；extra = 网关有但没配进 DSH 的。
runtime.set(CHAT_MODELS_SLOT, [
  "cn:deepseek-v4.1-flash",
  "cn:deepseek-v4-pro",
  "gpt-6-sol",
  "cn:glm-5.3",
]);
runtime.set(CHAT_GROUPS_SLOT, [
  {
    name: "wb",
    models: [
      { id: "cn:deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash" },
      { id: "cn:deepseek-v4-pro", name: "Deepseek-V4-Pro" },
    ],
  },
  { name: "gpt", models: [{ id: "gpt-6-sol", name: "gpt-6-sol" }] },
]);
runtime.set(CHAT_EXTRA_SLOT, ["cn:glm-5.3"]);
runtime.set(CHAT_CHOSEN_SLOT, "cn:deepseek-v4-pro");
runtime.reset();
tree = render();

const findModelSelect = (node) => {
  const select = [];
  walk(node, (n) => {
    if (n.type === "select" && optionValues(n).includes("cn:deepseek-v4.1-flash")) select.push(n);
  });
  return select[0] ?? null;
};
let modelSelect = findModelSelect(tree);
report("对话标题栏有模型下拉", modelSelect !== null, `options=${optionValues(modelSelect).join(",")}`);
report("下拉列出全部可用模型", optionValues(modelSelect).length === 4, optionValues(modelSelect).join(","));
report(
  "下拉按提供商分组",
  optionGroups(modelSelect).length === 3,
  optionGroups(modelSelect).join(" | "),
);
report(
  "分组标签带上提供商名与数量",
  optionGroups(modelSelect)[0] === "wb · 2 个模型",
  optionGroups(modelSelect)[0] ?? "-",
);
report(
  "最后一个分组是网关其余模型",
  String(optionGroups(modelSelect)[2] ?? "").startsWith("网关其余模型"),
  optionGroups(modelSelect)[2] ?? "-",
);
report("下拉绑定当前选中的模型", modelSelect?.props.value === "cn:deepseek-v4-pro", `value=${modelSelect?.props.value}`);

// 换模型 → POST /chat-config
const pickCalls = [];
globalThis.fetch = async (url, options) => {
  pickCalls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true, model: "cn:kimi-k3-1" }) };
};
modelSelect.props.onChange({ target: { value: "cn:kimi-k3-1" } });
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
runtime.reset();
tree = render();
report(
  "切换模型 POST 到 /chat-config",
  pickCalls.length === 1 && pickCalls[0].url.endsWith("/chat-config"),
  pickCalls[0]?.url ?? "未发起请求",
);
report("切换模型带上 model", pickCalls[0]?.body?.model === "cn:kimi-k3-1", JSON.stringify(pickCalls[0]?.body ?? null));
modelSelect = findModelSelect(tree);
report("切完下拉显示新模型", modelSelect?.props.value === "cn:kimi-k3-1", `value=${modelSelect?.props.value}`);

// 发送请求要把选中的模型带上
const sendCalls = [];
globalThis.fetch = async (url, options) => {
  sendCalls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ ok: true, reply: "好", model: "cn:kimi-k3-1", steps: [] }),
  };
};
runtime.set(CHAT_INPUT, "你好");
runtime.reset();
tree = render();
buttonByText(tree, "发送").props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
runtime.reset();
tree = render();
report(
  "发送请求带上了选中的模型",
  sendCalls[0]?.url?.endsWith("/chat") && sendCalls[0]?.body?.model === "cn:kimi-k3-1",
  `model=${sendCalls[0]?.body?.model}`,
);

// 模型报错 → 错误横幅
globalThis.fetch = async () => sseResponse([["error", { error: "模型网关不可达" }]]);
runtime.set(CHAT_INPUT, "再来一次");
runtime.reset();
tree = render();
buttonByText(tree, "发送").props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
runtime.reset();
tree = render();
report("模型出错时显示错误", textOf(tree).includes("模型网关不可达"), "错误横幅在");

// chatEnabled=false → 工具栏不出现 AI 对话入口
runtime.set(8, "files");
runtime.set(0, { ...loadedState, chatEnabled: false, connectionId: "ssh-config:ubuntu" });
runtime.set(1, null);
runtime.set(2, false);
runtime.set(4, null);
runtime.set(5, null);
runtime.set(CHAT_INPUT, "");
runtime.reset();
tree = render();
report("chatEnabled=false 时不显示 AI 对话按钮", !textOf(tree).includes("✦ AI 对话"), "按钮已隐藏");
report("chatEnabled=false 时文件页照常", textOf(tree).includes("⟳ 刷新"), "文件页不受影响");

// ────────────────────────────────────────────── 编辑远端文件（draft = 槽位 13）

const firstTextarea = (source) => {
  let found = null;
  walk(source, (node) => {
    if (found === null && node.type === "textarea") found = node;
  });
  return found;
};

runtime.clear();
runtime.set(0, { ...loadedState, connectionId: "ssh-config:ubuntu", path: "/home/admin" });
runtime.set(1, { ok: true, binary: false, size: 12, path: "/home/admin/hello.py", truncated: false, text: "print('hi')\n" });
runtime.set(2, false);
runtime.set(4, null);
runtime.set(5, null);
runtime.set(8, "files");
runtime.set(EDIT_DRAFT_SLOT, null);
runtime.reset();
tree = render();

report("预览文本文件时有「编辑」按钮", Boolean(buttonByText(tree, "编辑")), "找到编辑按钮");
report("未进入编辑态时还是只读 pre", firstTextarea(tree) === null, "没有 textarea");

buttonByText(tree, "编辑").props.onClick();
runtime.reset();
tree = render();
report("点「编辑」后变成编辑框", firstTextarea(tree) !== null, "textarea 出现了");
report(
  "编辑框带出原文件内容",
  firstTextarea(tree)?.props.value === "print('hi')\n",
  `value=${JSON.stringify(firstTextarea(tree)?.props.value)}`,
);
report("刚进编辑态没有「未保存」标记", !textOf(tree).includes("未保存"), "无脏标记");
report("编辑态有保存与取消按钮", Boolean(buttonByText(tree, "保存")) && Boolean(buttonByText(tree, "取消")), "两个按钮都在");

firstTextarea(tree).props.onChange({ target: { value: "print('hello, world')\n" } });
runtime.reset();
tree = render();
report("改动后出现「未保存」标记", textOf(tree).includes("未保存"), "脏标记出现");
report(
  "改动后编辑框 value 跟着变",
  firstTextarea(tree)?.props.value === "print('hello, world')\n",
  `value=${JSON.stringify(firstTextarea(tree)?.props.value)}`,
);

// Ctrl+S → POST /write
const writes = [];
globalThis.fetch = async (url, options) => {
  const target = String(url);
  const body = options?.body ? JSON.parse(options.body) : null;
  writes.push({ url: target, body });
  const payload = target.includes("/write")
    ? { ok: true, path: "/home/admin/hello.py", bytes: 22, existed: true, backup: "/home/admin/hello.py.re-bak", mode: "0o644" }
    : { ok: true, path: "/home/admin", parent: "/home", entries: [] };
  return { ok: true, status: 200, statusText: "OK", json: async () => payload };
};

firstTextarea(tree).props.onKeyDown({ key: "s", ctrlKey: true, preventDefault() {} });
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
runtime.reset();
tree = render();

const writeCall = writes.find((item) => item.url.includes("/write"));
report("Ctrl+S 触发 POST /write", Boolean(writeCall), writes.map((w) => w.url).join(" | ") || "未发起请求");
report(
  "写请求带 connection 与 path",
  writeCall?.body?.connection === "ssh-config:ubuntu" && writeCall?.body?.path === "/home/admin/hello.py",
  JSON.stringify(writeCall?.body ?? null),
);
report("写请求带新内容", writeCall?.body?.content === "print('hello, world')\n", JSON.stringify(writeCall?.body?.content ?? null));
report("保存成功后提示字节数与备份路径", textOf(tree).includes("已保存") && textOf(tree).includes("hello.py.re-bak"), textOf(tree).slice(0, 160));
report("保存后「未保存」标记消失", !textOf(tree).includes("未保存"), "脏标记已清");

// 截断的大文件不给编辑入口
runtime.clear();
runtime.set(0, { ...loadedState, connectionId: "ssh-config:ubuntu", path: "/home/admin" });
runtime.set(1, { ok: true, binary: false, size: 900000, path: "/home/admin/big.log", truncated: true, text: "x\n" });
runtime.set(2, false);
runtime.set(4, null);
runtime.set(5, null);
runtime.set(8, "files");
runtime.set(EDIT_DRAFT_SLOT, null);
runtime.reset();
tree = render();
report("截断的大文件不显示「编辑」按钮", !buttonByText(tree, "编辑"), "按钮已隐藏");
report("截断的大文件说明不能编辑", textOf(tree).includes("不能在这里编辑"), "有提示语");

// ─────────────────────────────────────────── 拖拽传输（拖出 = 下载，拖入 = 上传）

/** 收集满足条件的元素（expand() 已经把函数组件展开，这里拿到的都是真实元素）。 */
function collect(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  collect(node.children, predicate, out);
  return out;
}

/** 让挂起的 Promise 链跑完（apiPost 里有两层 await）。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

runtime.clear();
runtime.set(0, { ...loadedState, connectionId: "ssh-config:ubuntu", path: "/home/admin" });
runtime.set(1, null);
runtime.set(2, false);
runtime.set(3, { ok: true, hostname: "myubuntu", os: "Linux" });
runtime.set(8, "files");
runtime.set(21, "desktop"); // 下载落点
runtime.set(23, []); // 任务表
runtime.set(24, true); // 抽屉展开
runtime.set(25, null); // 拖入高亮
runtime.reset();
tree = render();

const draggables = collect(tree, (node) => node.props && node.props.draggable === true);
report("三个条目行都能拖出去", draggables.length === 3, `draggable=${draggables.length}`);
report(
  "拖出行同时挂了 onDragStart / onDragEnd",
  draggables.every(
    (node) => typeof node.props.onDragStart === "function" && typeof node.props.onDragEnd === "function",
  ),
  draggables.map((node) => `${node.props.onDragStart ? "S" : "-"}${node.props.onDragEnd ? "E" : "-"}`).join(","),
);

const dropNodes = collect(tree, (node) => node.props && typeof node.props.onDrop === "function");
report("浏览区 + 目录行都能接收拖入", dropNodes.length === 2, `onDrop=${dropNodes.length}`);
report(
  "只有目录行（不是文件行）能当落点",
  dropNodes.filter((node) => node.props.draggable === true).length === 1,
  `行级落点=${dropNodes.filter((node) => node.props.draggable === true).length}`,
);

const downloadButtons = collect(
  tree,
  (node) => node.props && typeof node.props.onClick === "function" && textOf(node) === "⬇",
);
report("每个条目行行尾都有 ⬇ 下载", downloadButtons.length === 3, `⬇=${downloadButtons.length}`);

// 传送按钮全撤了：上传、下载此目录、落点下拉都不该再出现在界面上
const opsText2 = textOf(tree);
report("工具条不再有「⬆ 上传」入口", !opsText2.includes("⬆ 上传"), opsText2.includes("⬆ 上传") ? "还在" : "已撤");
report("ops 行不再有「⬇ 下载此目录」", !opsText2.includes("下载此目录"), "已撤");
report("工具条不再有「存到桌面」落点下拉", !opsText2.includes("存到桌面"), "已撤");
report("没选中时不渲染选中栏", !opsText2.includes("已选"), "没渲染");

// ── 单击选中 / Ctrl 多选 / 整批拖出 / 右键与 Del 删除 ──
runtime.reset();
runtime.set(0, { ...loadedState, connectionId: "ssh-config:ubuntu", path: "/home/admin" });
runtime.set(1, null);
runtime.set(3, { ok: true, hostname: "myubuntu", os: "Linux" });
runtime.set(8, "files");
runtime.set(23, []);
runtime.set(24, false);
runtime.set(34, []);
runtime.reset();
tree = render();

/** 从拖出回调里把这一行的远端全路径抠出来（顺便验证单条拖出写的是谁）。 */
const pathOf = (node) => {
  const rec = { writes: [], setData: (type, value) => rec.writes.push([type, value]) };
  node.props.onDragStart({ dataTransfer: rec });
  node.props.onDragEnd();
  return rec.writes[0]?.[1] ?? "";
};
let rows = collect(tree, (node) => node.props && node.props.draggable === true);
const rowPaths = rows.map(pathOf);
const [p0, p1, p2] = rowPaths;
const clickRow = (node, extra = {}) =>
  node.props.onClick({ ctrlKey: false, metaKey: false, shiftKey: false, ...extra });

report("三行的路径各不相同", new Set(rowPaths).size === 3, rowPaths.join(" | "));

clickRow(rows[0]);
report("不按 Ctrl 单击 = 单选这一条", JSON.stringify(runtime.peek(34)) === JSON.stringify([p0]), JSON.stringify(runtime.peek(34)));

clickRow(rows[1], { ctrlKey: true });
report(
  "按住 Ctrl 再点一行 = 加进选中集合（多选）",
  JSON.stringify(runtime.peek(34)) === JSON.stringify([p0, p1]),
  JSON.stringify(runtime.peek(34)),
);

clickRow(rows[1], { ctrlKey: true });
report("Ctrl 再点已选中的行 = 取消这一条", JSON.stringify(runtime.peek(34)) === JSON.stringify([p0]), JSON.stringify(runtime.peek(34)));

clickRow(rows[2]);
report(
  "不带 Ctrl 点别的行 = 换掉整个选中集合",
  JSON.stringify(runtime.peek(34)) === JSON.stringify([p2]),
  JSON.stringify(runtime.peek(34)),
);

// 选中栏 + 整批拖出
runtime.set(34, [p0, p1]);
runtime.reset();
tree = render();
const selText = textOf(tree);
report("选中后出现「已选 N 项」栏", selText.includes("已选 2 项"), selText.slice(0, 160));
report("选中栏给「删除 N 项」按钮", selText.includes("删除 2 项"), "删除按钮在");

// 选中栏必须是「浮条」：绝对定位、不占布局，否则选中时会把文件往下挤一行。
const floatBar = collect(
  tree,
  (node) => node.props && node.props.style && node.props.style.position === "absolute" && textOf(node).includes("已选 2 项"),
);
report("选中栏是浮条（absolute），不占布局高度", floatBar.length === 1, `absolute 浮条数=${floatBar.length}`);
const opsRow = collect(
  tree,
  (node) => node.props && node.props.style && node.props.style.borderBottom === "1px solid rgba(127,127,127,0.15)",
)[0];
report("选中后 ops 行（认证那行）里不再塞选中提示", opsRow !== undefined && !textOf(opsRow).includes("已选"), textOf(opsRow ?? {}).slice(0, 80));
const listBoxSel = collect(tree, (node) => node.props && node.props.style && node.props.style.overflow === "auto" && node.props.style.width !== undefined)[0];
report("选中时列表底部留出浮条的高度", Number(listBoxSel?.props?.style?.paddingBottom ?? 0) >= 40, `paddingBottom=${listBoxSel?.props?.style?.paddingBottom}`);
runtime.set(34, []);
tree = render();
const listBoxEmpty = collect(tree, (node) => node.props && node.props.style && node.props.style.overflow === "auto" && node.props.style.width !== undefined)[0];
report("没选中时列表不带额外内边距（不占位、不留白）", listBoxEmpty?.props?.style?.paddingBottom === undefined, `paddingBottom=${listBoxEmpty?.props?.style?.paddingBottom}`);
runtime.set(34, [p0, p1]);
tree = render();

rows = collect(tree, (node) => node.props && node.props.draggable === true);
const batch = { writes: [], setData: (type, value) => batch.writes.push([type, value]) };
rows[0].props.onDragStart({ dataTransfer: batch });
rows[0].props.onDragEnd();
report(
  "拖选中行 = 把整批路径写进 text/plain（批量传输）",
  batch.writes[0]?.[1] === `${p0}\n${p1}`,
  JSON.stringify(batch.writes),
);

// 右键菜单
const menuCalls = [];
globalThis.fetch = async (url, options) => {
  const target = String(url);
  const body = options?.body ? JSON.parse(options.body) : null;
  menuCalls.push({ target, method: String(options?.method ?? "GET"), body });
  if (target.includes("/delete")) {
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true, removed: 2, failed: [] }) };
  }
  if (target.includes("/pull")) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, job: { id: "job-9", kind: "download", title: "batch", state: "running", items: [], bytes: 0, total: 0 } }),
    };
  }
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true, entries: [], path: "/home/admin", parent: null }) };
};

let menuPrevented = 0;
rows[1].props.onContextMenu({
  clientX: 40,
  clientY: 60,
  preventDefault: () => {
    menuPrevented += 1;
  },
});
report("右键先挡住浏览器自带菜单", menuPrevented === 1, `preventDefault=${menuPrevented}`);
report(
  "右键在已选中的行上 = 菜单作用于整个选中集合",
  Array.isArray(runtime.peek(35)?.paths) && runtime.peek(35).paths.length === 2,
  JSON.stringify(runtime.peek(35)?.paths),
);

runtime.reset();
tree = render();
const menuText = textOf(tree);
report("右键菜单有下载 / 删除 / 取消选择", menuText.includes("⬇ 下载到") && menuText.includes("🗑 删除 2 项") && menuText.includes("取消选择"), menuText.slice(0, 200));

const menuDownload = collect(
  tree,
  (node) => node.props && typeof node.props.onClick === "function" && textOf(node).startsWith("⬇ 下载到"),
)[0];
report("菜单里找得到下载项", Boolean(menuDownload), "有");
if (menuDownload) {
  menuDownload.props.onClick();
  await tick();
  await tick();
  const batchPull = menuCalls.find((item) => item.target.includes("/pull"));
  report(
    "菜单下载 = POST /pull 带上整批路径",
    Boolean(batchPull) && JSON.stringify(batchPull.body.paths) === JSON.stringify([p0, p1]),
    JSON.stringify(batchPull?.body ?? null),
  );
}

// 再右键一次 → 点删除 → 二次确认 → POST /delete
runtime.set(35, null);
runtime.reset();
tree = render();
rows = collect(tree, (node) => node.props && node.props.draggable === true);
rows[0].props.onContextMenu({ clientX: 20, clientY: 30, preventDefault: () => {} });
runtime.reset();
tree = render();
const deleteItem = buttonByText(tree, "🗑 删除 2 项");
report("菜单里有删除项", Boolean(deleteItem), "有");
deleteItem?.props.onClick();
report("点删除先要二次确认（不直接发请求）", Array.isArray(runtime.peek(36)) && runtime.peek(36).length === 2, JSON.stringify(runtime.peek(36)));
report("确认前没有发出删除请求", menuCalls.every((item) => !item.target.includes("/delete")), menuCalls.map((item) => item.target).join(" | "));

runtime.reset();
tree = render();
report("确认框写明项数与不可恢复", textOf(tree).includes("删除 2 项？") && textOf(tree).includes("不可恢复"), textOf(tree).slice(0, 200));
// 注意用「完全相等」去找确认按钮：选中栏上那个是「🗑 删除 2 项」，含 emoji。
const confirmButton = collect(
  tree,
  (node) => node.props && typeof node.props.onClick === "function" && textOf(node) === "删除 2 项",
)[0];
report("确认框有确认按钮", Boolean(confirmButton), "有");
confirmButton?.props.onClick();
await tick();
await tick();
const rowDeleteCall = menuCalls.find((item) => item.target.includes("/delete"));
report(
  "确认后 POST /delete 带 connection 与整批 paths",
  Boolean(rowDeleteCall) && rowDeleteCall.body.connection === "ssh-config:ubuntu" && JSON.stringify(rowDeleteCall.body.paths) === JSON.stringify([p0, p1]),
  JSON.stringify(rowDeleteCall?.body ?? null),
);
report("删完清空选中", JSON.stringify(runtime.peek(34)) === "[]", JSON.stringify(runtime.peek(34)));

// 取消选择按钮
runtime.set(34, [p0]);
runtime.reset();
tree = render();
buttonByText(tree, "取消选择")?.props.onClick();
report("「取消选择」清空选中集合", JSON.stringify(runtime.peek(34)) === "[]", JSON.stringify(runtime.peek(34)));

runtime.set(34, []);
runtime.set(35, null);
runtime.set(36, null);
runtime.reset();
tree = render();

// 拖出：dataTransfer 写出远端路径（粘到终端里也能用）
const dragData = { writes: [], setData: (type, value) => dragData.writes.push([type, value]), effectAllowed: "" };
draggables[0].props.onDragStart({ dataTransfer: dragData });
report(
  "拖出时把远端路径写进 text/plain",
  dragData.writes[0]?.[0] === "text/plain" && dragData.writes[0]?.[1] === "/home/admin/桌面",
  JSON.stringify(dragData.writes),
);
report("拖出时把 effectAllowed 设成 copy", dragData.effectAllowed === "copy", `effectAllowed=${dragData.effectAllowed}`);
draggables[0].props.onDragEnd(); // 没离开窗口 → 不该发请求

// 点行尾 ⬇ → POST /pull（目标 = 桌面）
const transferCalls = [];
globalThis.fetch = async (url, options) => {
  const target = String(url);
  transferCalls.push({ url: target, body: options?.body ? JSON.parse(options.body) : null });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      ok: true,
      job: {
        id: "job-1",
        kind: "download",
        title: "notes.txt",
        state: "running",
        phase: "准备中",
        items: [],
        bytes: 0,
        total: 0,
        target: "C:\\Users\\demo\\Desktop",
        openPath: "",
      },
    }),
  };
};

report("没拖出窗口时不会误发下载请求", transferCalls.length === 0, `请求数=${transferCalls.length}`);

downloadButtons[1].props.onClick({ stopPropagation() {} });
await tick();
await tick();

const pullCall = transferCalls.find((item) => item.url.includes("/pull"));
report("点行尾 ⬇ 触发 POST /pull", Boolean(pullCall), transferCalls.map((item) => item.url).join(" | ") || "未发起请求");
report(
  "下载请求带 connection / paths / target",
  pullCall?.body?.connection === "ssh-config:ubuntu" &&
    JSON.stringify(pullCall?.body?.paths) === '["/home/admin/notes.txt"]' &&
    pullCall?.body?.target === "desktop",
  JSON.stringify(pullCall?.body ?? null),
);

runtime.reset();
tree = render();
report("传输抽屉里出现新任务", textOf(tree).includes("notes.txt"), textOf(tree).slice(-120));

// 抽屉进度：512/1024 → 进度条 50%
runtime.set(23, [
  {
    id: "job-1",
    kind: "download",
    title: "notes.txt",
    state: "running",
    phase: "下载中",
    items: [],
    bytes: 512,
    total: 1024,
    target: "C:\\Users\\21368\\Desktop",
    openPath: "",
  },
]);
runtime.reset();
tree = render();
report(
  "抽屉按字节算进度条宽度",
  collect(tree, (node) => node.props?.style?.width === "50%").length === 1,
  `50% 的元素数=${collect(tree, (node) => node.props?.style?.width === "50%").length}`,
);
report("跑步中的任务有「取消」", Boolean(buttonByText(tree, "取消")), "取消按钮在");
report("抽屉显示已传字节 / 总量", textOf(tree).includes("/"), textOf(tree).slice(-140));

runtime.set(24, false);
runtime.reset();
tree = render();
report("收起抽屉后不再渲染任务卡", !textOf(tree).includes("下载中"), "抽屉已隐藏");
runtime.set(24, true);
runtime.set(23, []);

// 拖入：先从浏览区 onDragOver 打开高亮，再 onDrop
runtime.reset();
tree = render();
const bodyDrop = collect(tree, (node) => node.props?.style?.position === "relative" && typeof node.props?.onDrop === "function")[0];
report("找得到浏览区落点", Boolean(bodyDrop), bodyDrop ? "已找到" : "未找到");

const filesTransfer = { types: ["Files"], files: [], items: [] };
let prevented = 0;
let stopped = 0;
bodyDrop.props.onDragOver({ dataTransfer: filesTransfer, preventDefault() {}, stopPropagation() {} });
report("拖进来时把当前目录标成落点", runtime.peek(25) === "/home/admin", `dropTarget=${runtime.peek(25)}`);

runtime.reset();
tree = render();
report("落点高亮时给出提示语", textOf(tree).includes("松手传到"), textOf(tree).slice(-80));

bodyDrop.props.onDrop({
  dataTransfer: filesTransfer,
  preventDefault: () => {
    prevented += 1;
  },
  stopPropagation: () => {
    stopped += 1;
  },
});
await tick();
await tick();
report("拖入时同时挡住默认行为与冒泡（否则外壳会接管）", prevented === 1 && stopped === 1, `prevent=${prevented} stop=${stopped}`);
report("拖入后清掉落点高亮", runtime.peek(25) === null, `dropTarget=${runtime.peek(25)}`);

runtime.reset();
tree = render();
report(
  "读不到文件时给出可读报错",
  textOf(tree).includes("没从拖进来的内容里读到文件"),
  textOf(tree).slice(0, 120),
);

// 内部拖动（text/plain）不该被当成上传
let ignored = 0;
bodyDrop.props.onDrop({
  dataTransfer: { types: ["text/plain"], files: [], items: [] },
  preventDefault: () => {
    ignored += 1;
  },
  stopPropagation() {},
});
report("内部拖动不触发上传", ignored === 0, `prevent=${ignored}`);

// ─────────────────────────────────────────── 连接管理（删除不再需要的设备）

const connReply = (payload) => ({ ok: true, status: 200, statusText: "OK", json: async () => payload });
const connCalls = [];
let connList = [...loadedState.connections];
let connHidden = [{ id: "ssh-config:old", name: "old-vm", host: "192.168.22.130", hiddenAt: 1 }];
globalThis.fetch = async (url, options) => {
  const target = String(url);
  const method = String(options?.method ?? "GET").toUpperCase();
  const body = options?.body ? JSON.parse(options.body) : null;
  connCalls.push({ target, method, body });
  if (target.includes("/connections")) {
    if (method !== "GET") {
      if (body?.action === "delete") {
        connList = connList.filter((item) => item.id !== body.id);
        connHidden = [{ id: body.id, name: body.id, host: "", hiddenAt: 2 }, ...connHidden];
      }
      if (body?.action === "restore") {
        connHidden = connHidden.filter((item) => item.id !== body.id);
      }
      return connReply({ ok: true });
    }
    return connReply({ ok: true, connections: connList, hidden: connHidden });
  }
  if (target.includes("/list")) return connReply({ ok: true, path: "/home/admin", parent: "/home", entries: [] });
  if (target.includes("/info")) return connReply({ ok: true, hostname: "myubuntu", os: "Linux" });
  return connReply({ ok: true });
};

runtime.clear();
runtime.set(0, { ...loadedState, hidden: connHidden });
runtime.set(1, null);
runtime.set(2, false);
runtime.set(3, null);
runtime.reset();
tree = render();

report("工具条有「管理连接」入口", Boolean(buttonByText(tree, "管理连接")), textOf(tree).slice(0, 100));
report("没点开时不渲染管理浮层", !textOf(tree).includes("连接管理 ·"), "未展开");

runtime.set(32, true);
runtime.reset();
tree = render();
const managerText = textOf(tree);
report("管理浮层列出全部连接", managerText.includes("连接管理 · 2 台"), managerText.slice(-160));
report("管理浮层标出连接来源", managerText.includes("自建连接") && managerText.includes("来自 ~/.ssh/config"), "来源标签在");
report("已删除的连接单独成组", managerText.includes("已删除（1）") && managerText.includes("old-vm"), "已删除组在");

const managerDeletes = collect(tree, (node) => node.type === "button" && textOf(node) === "删除");
report("每条连接都有删除按钮（+ 上方工具条那一个）", managerDeletes.length === 3, `删除按钮=${managerDeletes.length}`);
report("已删除的连接有「恢复」", Boolean(buttonByText(tree, "恢复")), "恢复按钮在");

// 第一次点 = 只是进确认态，不许立刻发请求
const beforeAsk = connCalls.length;
managerDeletes[1].props.onClick(); // 第 2 个 = 连接清单里的第一台（ssh-config:ubuntu）
await tick();
report("点删除先要一次确认", runtime.peek(33) === "ssh-config:ubuntu" && connCalls.length === beforeAsk, `pending=${runtime.peek(33)}`);

runtime.reset();
tree = render();
report("确认态显示「确认删除 / 取消」", textOf(tree).includes("确认删除") && Boolean(buttonByText(tree, "取消")), textOf(tree).slice(-120));

buttonByText(tree, "确认删除").props.onClick();
await tick();
await tick();
await tick();
const deleteCall = connCalls.find((item) => item.body?.action === "delete");
report(
  "确认后 POST /connections action=delete",
  deleteCall?.body?.id === "ssh-config:ubuntu",
  JSON.stringify(deleteCall?.body ?? null),
);
report(
  "删掉当前连接后自动切到剩下那台",
  runtime.peek(0)?.connectionId === "user:abc",
  `connectionId=${runtime.peek(0)?.connectionId}`,
);
report("删完把待确认清掉", runtime.peek(33) === null, `pending=${runtime.peek(33)}`);

// 恢复：从「已删除」放回清单
connCalls.length = 0;
runtime.set(32, true);
runtime.reset();
tree = render();
const restoreButtons = collect(tree, (node) => node.type === "button" && textOf(node) === "恢复");
report("删掉的连接还在浮层里可恢复", restoreButtons.length === 2, `恢复按钮=${restoreButtons.length}`);
restoreButtons[0].props.onClick(); // 列表最上面那条 = 刚删掉的 ssh-config:ubuntu
await tick();
await tick();
const restoreCall = connCalls.find((item) => item.body?.action === "restore");
report("点恢复 POST /connections action=restore", restoreCall?.body?.id === "ssh-config:ubuntu", JSON.stringify(restoreCall?.body ?? null));

runtime.set(32, false);
runtime.reset();
tree = render();
report("关掉管理浮层后不再渲染", !textOf(tree).includes("连接管理 ·"), "已关闭");

// ─────────────────────────────────────────── 空白处右键新建 / 行右键重命名

// 「输入名字」浮层是 ExplorerPanel 的第 38 个 hook（0 基槽位 37；38、39 是两个 effect）。
const PROMPT = 37;

const mutateCalls = [];
globalThis.fetch = async (url, options) => {
  const target = String(url);
  const body = options?.body ? JSON.parse(options.body) : null;
  mutateCalls.push({ target, method: String(options?.method ?? "GET").toUpperCase(), body });
  if (target.includes("/create")) {
    if (body?.name === "重名.txt") {
      return { ok: false, status: 409, statusText: "Conflict", json: async () => ({ ok: false, error: "已存在同名文件或文件夹" }) };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, path: `${body.dir}/${body.name}`, kind: body.kind }),
    };
  }
  if (target.includes("/rename")) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, path: `/home/admin/${body.name}`, from: body.path }),
    };
  }
  if (target.includes("/list")) {
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true, path: "/home/admin", parent: "/home", entries: loadedState.entries }) };
  }
  if (target.includes("/info")) {
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true, hostname: "myubuntu", os: "Linux" }) };
  }
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true }) };
};

runtime.clear();
runtime.set(0, { ...loadedState, connectionId: "ssh-config:ubuntu", path: "/home/admin" });
runtime.set(1, null);
runtime.set(2, false);
runtime.set(3, { ok: true, hostname: "myubuntu", os: "Linux" });
runtime.set(8, "files");
runtime.set(23, []);
runtime.set(24, false);
runtime.set(34, []);
runtime.set(35, null);
runtime.set(36, null);
runtime.set(PROMPT, null);
runtime.reset();
tree = render();

/** 列表容器：唯一同时挂了「点空白清选中」和「右键新建」的那个 div。 */
const findListBox = (node) =>
  collect(
    node,
    (item) => item.props?.style?.flex === "0 0 auto" && typeof item.props?.onContextMenu === "function",
  )[0];
const listBox = findListBox(tree);
report("找得到列表空白区（右键新建的入口）", Boolean(listBox), listBox ? "已找到" : "未找到");

let blankPrevented = 0;
listBox.props.onContextMenu({
  clientX: 100,
  clientY: 120,
  target: {},
  currentTarget: {},
  preventDefault: () => {
    blankPrevented += 1;
  },
  stopPropagation() {},
});
// 上面的 target/currentTarget 是「同一个对象」才会被当成空白处，这里补一个真事件再走一遍。
blankPrevented = 0;
const blankEvent = { clientX: 100, clientY: 120, preventDefault: () => { blankPrevented += 1; }, stopPropagation() {} };
blankEvent.target = blankEvent.currentTarget;
listBox.props.onContextMenu(blankEvent);
report("空白处右键先挡住浏览器自带菜单", blankPrevented === 1, `preventDefault=${blankPrevented}`);
report(
  "空白处右键 = 菜单作用于当前目录（不是某一行）",
  Array.isArray(runtime.peek(35)?.paths) && runtime.peek(35).paths.length === 0 && runtime.peek(35)?.dir === "/home/admin",
  JSON.stringify(runtime.peek(35)),
);

runtime.reset();
tree = render();
const blankMenuText = textOf(tree);
report(
  "空白处菜单有「新建文件」「新建文件夹」",
  blankMenuText.includes("新建文件") && blankMenuText.includes("新建文件夹"),
  blankMenuText.slice(0, 160),
);
report("空白处菜单没有下载 / 删除项", !blankMenuText.includes("⬇ 下载到") && !blankMenuText.includes("🗑 删除"), blankMenuText.slice(0, 160));

/** 找菜单里的某一项：文案含 label，且命中的是最里层那一个（卡片本身也含文案，不能选到它）。 */
const menuItem = (source, label) => {
  const hits = collect(
    source,
    (node) => node.props && typeof node.props.onClick === "function" && textOf(node).includes(label),
  );
  hits.sort((a, b) => textOf(a).length - textOf(b).length);
  return hits[0];
};

const newFileItem = menuItem(tree, "新建文件");
newFileItem.props.onClick();
report(
  "点「新建文件…」打开输入框（模式 newfile、落在当前目录）",
  runtime.peek(PROMPT)?.mode === "newfile" && runtime.peek(PROMPT)?.dir === "/home/admin" && runtime.peek(35) === null,
  JSON.stringify(runtime.peek(PROMPT)),
);

runtime.reset();
tree = render();
const promptText = textOf(tree);
const promptInput = collect(tree, (node) => node.type === "input" && node.props?.placeholder === "文件名")[0];
report("输入框浮层写出位置", promptText.includes("新建文件") && promptText.includes("位置 · /home/admin"), promptText.slice(0, 160));
report("输入框浮层有输入框与「确定 / 取消」", Boolean(promptInput) && Boolean(buttonByText(tree, "确定")) && Boolean(buttonByText(tree, "取消")), `input=${Boolean(promptInput)}`);

// 空名字 → 不发请求，就地报错
buttonByText(tree, "确定").props.onClick();
await tick();
report("名字为空时不发请求并就地提示", runtime.peek(PROMPT)?.error === "名字不能为空" && !mutateCalls.some((item) => item.target.includes("/create")), `${runtime.peek(PROMPT)?.error}`);

runtime.reset();
tree = render();
const promptInput2 = collect(tree, (node) => node.type === "input" && node.props?.placeholder === "文件名")[0];
promptInput2.props.onChange({ target: { value: "新 建.txt" } });
runtime.reset();
tree = render();
const promptInput3 = collect(tree, (node) => node.type === "input" && node.props?.placeholder === "文件名")[0];
promptInput3.props.onKeyDown({ key: "Enter", preventDefault() {} });
await tick();
await tick();
const createCall = mutateCalls.find((item) => item.target.includes("/create"));
report(
  "回车提交 = POST /create（file，带 connection / dir / name）",
  createCall?.body?.connection === "ssh-config:ubuntu" &&
    createCall?.body?.dir === "/home/admin" &&
    createCall?.body?.name === "新 建.txt" &&
    createCall?.body?.kind === "file",
  JSON.stringify(createCall?.body ?? null),
);
report("新建成功后关掉浮层", runtime.peek(PROMPT) === null, `${runtime.peek(PROMPT)}`);
report(
  "新建成功后把新条目选中",
  JSON.stringify(runtime.peek(34)) === JSON.stringify(["/home/admin/新 建.txt"]),
  JSON.stringify(runtime.peek(34)),
);

// 新建文件夹：kind=dir
mutateCalls.length = 0;
runtime.set(35, { x: 10, y: 10, paths: [], dir: "/home/admin" });
runtime.reset();
tree = render();
const newDirItem = menuItem(tree, "新建文件夹");
newDirItem.props.onClick();
runtime.set(34, []);
runtime.reset();
tree = render();
const dirInput = collect(tree, (node) => node.type === "input" && node.props?.placeholder === "文件夹名字")[0];
dirInput.props.onChange({ target: { value: "新目录" } });
runtime.reset();
tree = render();
const dirInput2 = collect(tree, (node) => node.type === "input" && node.props?.placeholder === "文件夹名字")[0];
report("新建文件夹的浮层标题与占位符都对", textOf(tree).includes("新建文件夹"), "标题在");
buttonByText(tree, "确定").props.onClick();
await tick();
await tick();
const dirCall = mutateCalls.find((item) => item.target.includes("/create"));
report("新建文件夹带 kind=dir", dirCall?.body?.kind === "dir" && dirCall?.body?.name === "新目录", JSON.stringify(dirCall?.body ?? null));

// 名字里带分隔符 → 就地报错
mutateCalls.length = 0;
runtime.set(PROMPT, { mode: "newfile", target: "", dir: "/home/admin", value: "a/b.txt", error: null, busy: false });
runtime.reset();
tree = render();
buttonByText(tree, "确定").props.onClick();
await tick();
report(
  "名字带分隔符时就地拒绝（不发请求）",
  String(runtime.peek(PROMPT)?.error ?? "").includes("分隔符") && !mutateCalls.some((item) => item.target.includes("/create")),
  `${runtime.peek(PROMPT)?.error}`,
);

// 服务端说重名 → 浮层里显示，且不关
mutateCalls.length = 0;
runtime.set(PROMPT, { mode: "newfile", target: "", dir: "/home/admin", value: "重名.txt", error: null, busy: false });
runtime.reset();
tree = render();
buttonByText(tree, "确定").props.onClick();
await tick();
await tick();
report(
  "宿主说重名时把原因显示在浮层里",
  String(runtime.peek(PROMPT)?.error ?? "").includes("已存在"),
  `${runtime.peek(PROMPT)?.error}`,
);

// Esc 关掉浮层
runtime.set(PROMPT, { mode: "newfile", target: "", dir: "/home/admin", value: "x", error: null, busy: false });
runtime.reset();
tree = render();
const escInput = collect(tree, (node) => node.type === "input" && node.props?.placeholder === "文件名")[0];
escInput.props.onKeyDown({ key: "Escape", preventDefault() {} });
report("Esc 关掉输入框", runtime.peek(PROMPT) === null, `${runtime.peek(PROMPT)}`);

// 行右键 → 单条才有重命名
runtime.set(PROMPT, null);
runtime.set(35, null);
runtime.set(34, []);
runtime.reset();
tree = render();
rows = collect(tree, (node) => node.props && node.props.draggable === true);
rows[0].props.onContextMenu({ clientX: 20, clientY: 30, preventDefault() {}, stopPropagation() {} });
runtime.reset();
tree = render();
const singleMenuText = textOf(tree);
report("单选一条时菜单里有「重命名」", singleMenuText.includes("重命名"), singleMenuText.slice(0, 160));

runtime.set(34, [p0, p1]);
runtime.set(35, { x: 20, y: 30, paths: [p0, p1] });
runtime.reset();
tree = render();
report("多选时菜单里没有「重命名」（一次只改一个名字）", !textOf(tree).includes("重命名"), textOf(tree).slice(0, 160));

const renameItem = menuItem(tree, "重命名");
report("多选时确实找不到重命名入口", renameItem === undefined, renameItem ? "不该有" : "没有");

// 单条重命名：浮层带旧名字，提交后 POST /rename
runtime.set(34, [p0]);
runtime.set(35, { x: 20, y: 30, paths: [p0] });
runtime.reset();
tree = render();
const renameButton = menuItem(tree, "重命名");
renameButton.props.onClick();
report(
  "点重命名打开输入框（值 = 旧名字）",
  runtime.peek(PROMPT)?.mode === "rename" && runtime.peek(PROMPT)?.value === p0.split("/").pop() && runtime.peek(PROMPT)?.target === p0,
  JSON.stringify(runtime.peek(PROMPT)),
);

runtime.reset();
tree = render();
report("重命名浮层标题带旧名字", textOf(tree).includes(`重命名「${p0.split("/").pop()}」`), textOf(tree).slice(0, 160));

mutateCalls.length = 0;
const renameInput = collect(tree, (node) => node.type === "input" && node.props?.placeholder === "文件名")[0];
renameInput.props.onChange({ target: { value: "改好了.txt" } });
runtime.reset();
tree = render();
buttonByText(tree, "确定").props.onClick();
await tick();
await tick();
const renameCall = mutateCalls.find((item) => item.target.includes("/rename"));
report(
  "提交重命名 = POST /rename（connection / path / name）",
  renameCall?.body?.connection === "ssh-config:ubuntu" &&
    renameCall?.body?.path === p0 &&
    renameCall?.body?.name === "改好了.txt",
  JSON.stringify(renameCall?.body ?? null),
);
report("重命名后选中新路径", JSON.stringify(runtime.peek(34)) === JSON.stringify(["/home/admin/改好了.txt"]), JSON.stringify(runtime.peek(34)));

runtime.set(34, []);
runtime.set(35, null);
runtime.set(PROMPT, null);
runtime.reset();
tree = render();

console.log("");
console.log(failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);

