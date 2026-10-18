/**
 * dsh-ssh-explorer — client half.
 *
 * 手写的客户端模块：DSH 的 client module 系统直接读 `exports["./client"]` 指向的文件，
 * 只要求它是 `window.__ModuleLoader__.load({ id, factory })` 的形式，**不需要打包器**。
 * （revision 由文件 mtime/ctime/size 哈希得出，所以改完刷新页面即生效。）
 *
 * 贡献两块 UI：
 *  - `sidebar.panellist`：左侧活动栏的图标入口
 *  - `main`（keyed，同一个 id）：点图标后主区域显示的远程资源管理器
 *
 * 数据来自宿主半边的 HTTP 路由 `/x-ssh-explorer/*`（同源 fetch）。
 */

window.__ModuleLoader__.load({
  id: "dsh-ssh-explorer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");

    // ───────────────────────────────────────────────── 常量

    /** 活动栏条目与主面板共用的 id。 */
    const PANEL_ID = "ssh-explorer";
    /** 宿主半边注册的路由前缀。 */
    const API = "/x-ssh-explorer";
    /**
     * 能在这里编辑的文件大小上限。
     *
     * 必须和宿主半边的 `MAX_READ_BYTES`（512KB）一致：超过这个大小的文件
     * 读回来只有开头一段，要是允许编辑再存回去，等于把文件锯短。
     */
    const MAX_EDIT_BYTES = 512 * 1024;

    // ───────────────────────────────────────────────── 工具函数

    /** 调宿主半边的一个路由。 */
    async function api(path, params) {
      let url = `${API}/${path}`;
      if (params) {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
        }
        const text = search.toString();
        if (text.length > 0) url += `?${text}`;
      }
      const response = await fetch(url, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok && response.status !== 502 && response.status !== 404) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return response.json();
    }

    /** POST 一个 JSON 到宿主半边。 */
    async function apiPost(path, body) {
      const response = await fetch(`${API}/${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      return response.json();
    }

    /** GET 一个 JSON（宿主半边只做只读查询时用它）。 */
    async function apiGet(path) {
      const response = await fetch(`${API}/${path}`, {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      return response.json();
    }

    /** 人类可读的文件大小。 */
    function fmtSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return "";
      const units = ["B", "K", "M", "G", "T"];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
    }

    /** 时间戳 → 本地短时间。 */
    function fmtTime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return "";
      const date = new Date(seconds * 1000);
      const pad = (n) => String(n).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** 拼接 POSIX 路径。 */
    function joinPath(base, name) {
      if (base === "/") return `/${name}`;
      return `${base.replace(/\/+$/, "")}/${name}`;
    }

    /** 取父目录。 */
    function parentOf(path) {
      if (!path || path === "/") return null;
      const trimmed = path.replace(/\/+$/, "");
      const index = trimmed.lastIndexOf("/");
      if (index <= 0) return "/";
      return trimmed.slice(0, index);
    }

    /** 面包屑分段。 */
    function crumbsOf(path) {
      if (!path) return [];
      const parts = path.split("/").filter((part) => part.length > 0);
      const items = [{ label: "/", path: "/" }];
      let accumulated = "";
      for (const part of parts) {
        accumulated += `/${part}`;
        items.push({ label: part, path: accumulated });
      }
      return items;
    }

    // ───────────────────────────────────────────────── 拖拽传输：本机侧工具

    /** 下载落点（desktop / downloads / 绝对路径）记在这里。 */
    const DROP_DEST_KEY = "dsh-ssh-explorer.dropDest";
    /** 传输抽屉展开状态。 */
    const DRAWER_KEY = "dsh-ssh-explorer.drawerOpen";

    /** 读一个字符串偏好（localStorage 拿不到时用默认值）。 */
    function readStoredText(key, fallback) {
      try {
        if (typeof window === "undefined" || !window.localStorage) return fallback;
        const value = window.localStorage.getItem(key);
        return value === null || value === "" ? fallback : value;
      } catch {
        return fallback;
      }
    }

    /** 写一个字符串偏好（隐私模式下会抛，忽略）。 */
    function writeStoredText(key, value) {
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem(key, String(value));
        }
      } catch {
        /* 忽略 */
      }
    }

    /**
     * DSH 桌面版的 preload 无条件暴露了两个桥：
     *  - `__DSH_HOST_PATHS__.pathFor(file)` → 拖进来的东西在本机的真实路径
     *  - `__DSH_DIRECTORY_PICKER__.pick()`  → 系统选目录对话框
     *
     * 普通浏览器里两个都不存在，所以一律能力探测，不假设。
     */
    function hostPathBridge() {
      try {
        const bridge = typeof window !== "undefined" ? window.__DSH_HOST_PATHS__ : null;
        return bridge && typeof bridge.pathFor === "function" ? bridge : null;
      } catch {
        return null;
      }
    }

    /** 选本机目录的桥（只有桌面版有）。 */
    function directoryBridge() {
      try {
        const bridge = typeof window !== "undefined" ? window.__DSH_DIRECTORY_PICKER__ : null;
        return bridge && typeof bridge.pick === "function" ? bridge : null;
      } catch {
        return null;
      }
    }

    /** 取路径最后一段（Windows 的反斜杠也认）。 */
    function baseName(path) {
      const parts = String(path ?? "")
        .split(/[\\/]/)
        .filter((part) => part.length > 0);
      return parts.length > 0 ? parts[parts.length - 1] : "";
    }

    /** 这次拖动里有没有「文件」——行内部的拖动只有我们自己写的 text/plain。 */
    function hasFilePayload(dataTransfer) {
      if (dataTransfer === null || dataTransfer === undefined) return false;
      try {
        return Array.from(dataTransfer.types ?? []).includes("Files");
      } catch {
        return false;
      }
    }

    /**
     * 把 dataTransfer 里的每个 File 换成它在本机的绝对路径。
     *
     * 有一个取不到就返回 `null`：调用方据此退回「按字节流上传」的兜底路线。
     */
    function hostPathsOf(dataTransfer) {
      const bridge = hostPathBridge();
      if (bridge === null) return null;
      let files;
      try {
        files = Array.from(dataTransfer.files ?? []);
      } catch {
        return null;
      }
      if (files.length === 0) return null;
      const paths = [];
      for (const file of files) {
        let path = "";
        try {
          path = bridge.pathFor(file) || "";
        } catch {
          path = "";
        }
        if (path.length === 0) return null;
        paths.push(path);
      }
      return paths;
    }

    /** 递归读一个 DataTransferItem（可能是文件夹），产出 `[{ file, relPath }]`。 */
    async function drainEntry(entry, prefix, out, depth) {
      if (entry === null || entry === undefined || depth > 64) return;
      const name = String(entry.name ?? "");
      const base = prefix.length > 0 ? `${prefix}/${name}` : name;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        out.push({ file, relPath: base });
        return;
      }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch === null || batch === undefined || batch.length === 0) break;
        for (const child of batch) await drainEntry(child, base, out, depth + 1);
      }
    }

    /** 没有本机路径桥时，把拖进来的文件/文件夹读成 `[{ file, relPath }]`。 */
    async function collectDropped(dataTransfer) {
      let items = [];
      try {
        items = Array.from(dataTransfer?.items ?? []);
      } catch {
        items = [];
      }
      const roots = [];
      for (const item of items) {
        if (item.kind !== "file") continue;
        const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
        if (entry !== null && entry !== undefined) roots.push(entry);
      }
      if (roots.length > 0) {
        const out = [];
        for (const entry of roots) await drainEntry(entry, "", out, 0);
        return out;
      }
      let files = [];
      try {
        files = Array.from(dataTransfer?.files ?? []);
      } catch {
        files = [];
      }
      return files.map((file) => ({
        file,
        relPath: String(file.webkitRelativePath || file.name || ""),
      }));
    }

    /** 从「选整个文件夹」拿到的文件里反推那个文件夹的本机绝对路径（反推不出来返回空串）。 */
    function folderRootOf(files) {
      const bridge = hostPathBridge();
      if (bridge === null || files.length === 0) return "";
      const relative = String(files[0].webkitRelativePath || "");
      const parts = relative.split("/").filter((part) => part.length > 0);
      if (parts.length < 2) return "";
      let full = "";
      try {
        full = bridge.pathFor(files[0]) || "";
      } catch {
        full = "";
      }
      if (full.length === 0) return "";
      const tail = parts.slice(1).join("\\");
      const cut = full.length - tail.length - 1;
      if (cut <= 3) return "";
      return full.slice(0, cut);
    }

    /** 上传一个文件（字节流兜底）。用 XHR 才拿得到上传进度。 */
    function uploadBytes(connection, dir, relPath, file, onProgress) {
      return new Promise((resolve) => {
        const search = new URLSearchParams({
          connection,
          dir,
          relpath: relPath,
          mtime: String(file.lastModified || 0),
        });
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API}/upload?${search.toString()}`);
        xhr.upload.onprogress = (event) => {
          if (typeof onProgress === "function") onProgress(event.loaded || 0, event.total || 0);
        };
        xhr.onload = () => {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve({ ok: false, error: `HTTP ${xhr.status}` });
          }
        };
        xhr.onerror = () => resolve({ ok: false, error: "网络错误" });
        xhr.send(file);
      });
    }

    /** 任务状态 → 中文。 */
    const JOB_STATE_LABEL = { running: "进行中", done: "完成", failed: "失败", cancelled: "已取消" };
    /** 任务类型 → 图标。 */
    const JOB_KIND_ICON = { download: "⬇", upload: "⬆" };

    // ───────────────────────────────────────────────── 样式

    /**
     * 原生 <select> 的下拉列表由浏览器自己绘制，CSS 的 background 管不到它。
     * 不声明 color-scheme 时浏览器一律按浅色画（白底），而字色是从父级继承来的
     * 深色主题白字 —— 于是白底白字，看不清。
     * 这里显式给出底色/字色，并用 color-scheme 让下拉列表按同色系渲染。
     */
    function isDarkTheme() {
      try {
        return !document.body || document.body.hasAttribute("data-ds-dark-theme");
      } catch {
        return true;
      }
    }

    /** 输入类控件的配色。深色主题下必须自带底色 —— 背景是壁纸，
     *  透明底的输入框字全糊在花纹里；占位符也会看不清。 */
    function fieldColors() {
      return isDarkTheme()
        ? { bg: "rgba(8,20,36,0.78)", fg: "#eaf2ff", border: "rgba(150,180,220,0.38)", ph: "#8fa6c4" }
        : { bg: "#ffffff", fg: "#0e1f36", border: "rgba(20,50,90,0.30)", ph: "#6b7f97" };
    }

    function inputStyle() {
      const c = fieldColors();
      return {
        ...S.input,
        background: c.bg,
        color: c.fg,
        borderColor: c.border,
        colorScheme: isDarkTheme() ? "dark" : "light",
      };
    }

    function textareaStyle() {
      const c = fieldColors();
      return {
        ...S.textarea,
        background: c.bg,
        color: c.fg,
        borderColor: c.border,
        colorScheme: isDarkTheme() ? "dark" : "light",
      };
    }

    /** 原生 <select> 的下拉列表由浏览器自己绘制，CSS 的 background 管不到它。
     *  不声明 color-scheme 时浏览器一律按浅色画（白底），而字色是继承来的
     *  深色主题白字 —— 于是白底白字。color-scheme 让列表按同色系渲染。 */
    function selectStyle() {
      const c = fieldColors();
      return {
        ...S.select,
        background: c.bg,
        color: c.fg,
        borderColor: c.border,
        colorScheme: isDarkTheme() ? "dark" : "light",
      };
    }

    function optionStyle() {
      const c = fieldColors();
      return { background: c.bg, color: c.fg };
    }

    const S = {
      root: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        // 传输抽屉是绝对定位的浮层，靠这一层当定位基准。
        position: "relative",
        fontSize: 13,
        lineHeight: 1.5,
        color: "inherit",
      },
      bar: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderBottom: "1px solid rgba(127,127,127,0.25)",
        flexWrap: "wrap",
      },
      grow: { flex: 1, minWidth: 8 },
      button: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 10px",
        borderRadius: 6,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        cursor: "pointer",
      },
      buttonPrimary: {
        borderColor: "transparent",
        background: "rgba(64,132,240,0.85)",
        color: "#fff",
      },
      select: {
        padding: "4px 8px",
        borderRadius: 6,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        maxWidth: 220,
      },
      input: {
        padding: "4px 8px",
        borderRadius: 6,
        border: "1px solid rgba(150,180,220,0.38)",
        background: "rgba(8,20,36,0.78)",
        color: "#eaf2ff",
        colorScheme: "dark",
        font: "inherit",
        minWidth: 0,
        width: "100%",
        boxSizing: "border-box",
      },
      body: { display: "flex", flex: 1, minHeight: 0 },
      list: { flex: "1 1 55%", overflow: "auto", minWidth: 0 },
      preview: {
        flex: "1 1 45%",
        overflow: "auto",
        borderLeft: "1px solid rgba(127,127,127,0.25)",
        minWidth: 0,
      },
      // 竖直分隔条：看不见 6px 的命中区，只有中间 1px 视觉线。
      splitV: {
        flex: "0 0 auto",
        width: 6,
        cursor: "col-resize",
        touchAction: "none",
        backgroundImage:
          "linear-gradient(to right, rgba(127,127,127,0) 2px, rgba(127,127,127,0.45) 2px, rgba(127,127,127,0.45) 3px, rgba(127,127,127,0) 3px)",
      },
      // 「AI 对话」停靠时：左半边（原文件页）与右侧聊天栏都做成竖列容器。
      dockMain: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 },
      dockChat: {
        display: "flex",
        flexDirection: "column",
        flex: "0 0 auto",
        minWidth: 0,
        minHeight: 0,
        borderLeft: "1px solid rgba(127,127,127,0.25)",
      },
      row: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 12px",
        cursor: "pointer",
        whiteSpace: "nowrap",
      },
      cellName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
      cellMeta: { color: "rgba(127,127,127,1)", fontSize: 12, flex: "0 0 auto" },
      crumb: {
        cursor: "pointer",
        padding: "1px 4px",
        borderRadius: 4,
      },

      // ── 拖拽传输
      /** 行尾的「下载到桌面」小按钮：一直露着，只是不抢眼。 */
      rowAction: {
        flex: "0 0 auto",
        padding: "0 4px",
        borderRadius: 4,
        cursor: "pointer",
        opacity: 0.5,
        fontSize: 12,
        lineHeight: 1,
      },
      /** 拖入时高亮的那一行（目录）：整行描边，告诉用户「松手会放进这里」。 */
      rowDropping: {
        background: "rgba(64,150,255,0.18)",
        boxShadow: "inset 0 0 0 1px rgba(64,150,255,0.85)",
      },
      /** 拖入整个列表区域时的高亮。 */
      listDropping: { background: "rgba(64,150,255,0.10)", boxShadow: "inset 0 0 0 1px rgba(64,150,255,0.55)" },
      /** 「松手传到 XXX」的浮层提示。 */
      dropOverlay: {
        position: "absolute",
        left: 12,
        right: 12,
        top: 10,
        padding: "10px 12px",
        borderRadius: 8,
        border: "2px dashed rgba(64,150,255,0.75)",
        background: "rgba(8,20,36,0.88)",
        color: "#eaf2ff",
        fontSize: 13,
        textAlign: "center",
        pointerEvents: "none",
        zIndex: 25,
      },
      /** 传输抽屉。 */
      drawer: {
        position: "absolute",
        right: 14,
        bottom: 14,
        width: 380,
        maxWidth: "calc(100% - 28px)",
        maxHeight: "62%",
        overflow: "auto",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        borderRadius: 10,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "rgba(8,20,36,0.94)",
        color: "#eaf2ff",
        boxShadow: "0 12px 34px rgba(0,0,0,0.38)",
        zIndex: 30,
        fontSize: 12,
      },
      drawerHead: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600 },
      jobCard: {
        display: "flex",
        flexDirection: "column",
        gap: 5,
        padding: "7px 9px",
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,0.25)",
        background: "rgba(127,127,127,0.06)",
      },
      jobTitle: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
      jobName: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      jobMeta: { display: "flex", gap: 8, flexWrap: "wrap", color: "rgba(127,127,127,1)", fontSize: 11 },
      progress: {
        position: "relative",
        height: 5,
        borderRadius: 999,
        background: "rgba(127,127,127,0.25)",
        overflow: "hidden",
      },
      progressFill: {
        height: "100%",
        background: "rgba(64,150,255,0.9)",
        transition: "width 160ms linear",
      },
      jobError: { color: "rgba(240,140,140,1)", wordBreak: "break-all" },
      // 「⬆ 上传」展开后的那一行：跟工具条同宽，自然换行到下一行，不用浮层定位。
      uploadMenu: { display: "flex", alignItems: "center", gap: 6, width: "100%", paddingTop: 2, flexWrap: "wrap" },
      uploadMenuHint: {
        fontSize: 12,
        color: "rgba(127,127,127,1)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
      },

      // ── 选中与删除（单击选中、Ctrl 多选、Del / 右键删除）
      /** 选中行：和「拖入高亮」区分开，用偏青的底色 + 左侧竖条。 */
      rowSelected: {
        background: "rgba(64,190,255,0.16)",
        boxShadow: "inset 2px 0 0 rgba(64,190,255,0.9)",
      },
      /** 有选中项时浮在列表底部的浮条（绝对定位，不占布局高度，选中不挤动文件）。 */
      selBar: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
      selFloat: {
        position: "absolute",
        left: 12,
        bottom: 12,
        zIndex: 30,
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        maxWidth: "calc(100% - 24px)",
        padding: "7px 10px",
        borderRadius: 10,
        border: "1px solid rgba(120,200,255,0.32)",
        background: "rgba(6,18,32,0.94)",
        boxShadow: "0 10px 26px rgba(0,0,0,0.45)",
      },
      selHint: { fontSize: 12, color: "rgba(120,200,255,1)" },
      selButton: {
        flex: "0 0 auto",
        padding: "3px 9px",
        borderRadius: 6,
        border: "1px solid rgba(220,90,90,0.5)",
        background: "rgba(220,90,90,0.14)",
        color: "#ffd9d9",
        cursor: "pointer",
        fontSize: 12,
      },
      /** 右键菜单的透明背板：点一下任意地方就关掉（右键也关）。 */
      menuBackdrop: { position: "absolute", inset: 0, zIndex: 45 },
      /** 右键菜单本体：位置由点击坐标给，靠近右边/下边时会由代码夹回来。 */
      menuCard: {
        position: "fixed",
        minWidth: 190,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: 6,
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "rgba(8,20,36,0.98)",
        color: "#eaf2ff",
        boxShadow: "0 14px 34px rgba(0,0,0,0.45)",
        fontSize: 12,
      },
      menuTitle: {
        padding: "4px 8px 6px",
        color: "rgba(150,160,175,1)",
        fontSize: 11,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        maxWidth: 240,
      },
      menuItem: {
        textAlign: "left",
        padding: "6px 8px",
        borderRadius: 6,
        border: "none",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: 12,
      },
      menuItemDanger: {
        textAlign: "left",
        padding: "6px 8px",
        borderRadius: 6,
        border: "none",
        background: "transparent",
        color: "#ffb9b9",
        cursor: "pointer",
        fontSize: 12,
      },

      // ── 连接管理（删除设备）
      /** 半透明背板：点空白处关闭。 */
      managerBackdrop: {
        position: "absolute",
        inset: 0,
        background: "rgba(4,10,20,0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "48px 16px 16px",
        zIndex: 40,
      },
      managerCard: {
        width: 460,
        maxWidth: "100%",
        maxHeight: "100%",
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 14px",
        borderRadius: 10,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "rgba(8,20,36,0.97)",
        color: "#eaf2ff",
        boxShadow: "0 18px 44px rgba(0,0,0,0.45)",
        fontSize: 12,
      },
      connRow: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 9px",
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,0.22)",
        background: "rgba(127,127,127,0.06)",
      },
      connName: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      connMeta: { color: "rgba(150,160,175,1)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      connHint: { color: "rgba(150,160,175,1)", fontSize: 11, lineHeight: 1.5 },
      connGroup: { marginTop: 4, color: "rgba(150,160,175,1)", fontSize: 11, fontWeight: 600 },
      dangerButton: {
        flex: "0 0 auto",
        padding: "4px 10px",
        borderRadius: 6,
        border: "1px solid rgba(220,90,90,0.55)",
        background: "rgba(220,90,90,0.16)",
        color: "#ffd9d9",
        cursor: "pointer",
        fontSize: 12,
      },
      banner: {
        margin: "8px 12px",
        padding: "8px 10px",
        borderRadius: 6,
        fontSize: 12,
        background: "rgba(220,90,90,0.14)",
        border: "1px solid rgba(220,90,90,0.35)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      },
      hint: {
        padding: "24px 16px",
        color: "rgba(127,127,127,1)",
        textAlign: "center",
      },
      form: {
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        borderBottom: "1px solid rgba(127,127,127,0.25)",
        background: "rgba(8,20,36,0.62)",
        backdropFilter: "blur(8px)",
      },
      /** 表单里的一行：标签在左固定 72px，控件在右占满剩余宽度。
       *  <select>/<input> 必须放在这一层里，不能直接塞进 form 的 flex 列，
       *  否则拿不到「左标签 + 右控件」的两列布局。 */
      formRow: {
        display: "grid",
        gridTemplateColumns: "72px 1fr",
        gap: 10,
        alignItems: "center",
      },
      formTitle: { color: "#eaf2ff", fontSize: 13, fontWeight: 600 },
      formNote: {
        color: "rgba(178,196,220,0.9)",
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
      },
      inputRow: {
        display: "flex",
        alignItems: "center",
        gap: 6,
      },
      pre: {
        margin: 0,
        padding: 12,
        fontFamily: "Consolas, 'Cascadia Mono', monospace",
        fontSize: 12,
        whiteSpace: "pre",
        tabSize: 8,
      },
      head: {
        padding: "6px 12px",
        borderBottom: "1px solid rgba(127,127,127,0.25)",
        fontSize: 12,
        color: "rgba(127,127,127,1)",
        position: "sticky",
        top: 0,
        background: "inherit",
        backdropFilter: "blur(4px)",
      },

      // ── 编辑远端文件
      editorWrap: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
      editorBar: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderBottom: "1px solid rgba(127,127,127,0.25)",
        fontSize: 12,
        position: "sticky",
        top: 0,
        background: "inherit",
        backdropFilter: "blur(4px)",
        flexWrap: "wrap",
      },
      editorPath: {
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "rgba(127,127,127,1)",
      },
      editorBadge: {
        padding: "1px 6px",
        borderRadius: 999,
        fontSize: 11,
        background: "rgba(230,170,60,0.18)",
        border: "1px solid rgba(230,170,60,0.45)",
        whiteSpace: "nowrap",
      },
      editorArea: {
        flex: 1,
        minHeight: 0,
        width: "100%",
        boxSizing: "border-box",
        resize: "none",
        border: "none",
        outline: "none",
        padding: 12,
        fontFamily: "Consolas, 'Cascadia Mono', monospace",
        fontSize: 12,
        lineHeight: 1.55,
        tabSize: 4,
        background: "rgba(8,20,36,0.78)",
        color: "#eaf2ff",
        colorScheme: "dark",
        whiteSpace: "pre",
        overflow: "auto",
      },
      editorNote: {
        margin: "0 12px 8px",
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 12,
        background: "rgba(80,180,120,0.14)",
        border: "1px solid rgba(80,180,120,0.35)",
        wordBreak: "break-all",
      },

      // ── AI 对话
      chatRoot: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" },
      chatLog: {
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      },
      bubbleUser: {
        alignSelf: "flex-end",
        maxWidth: "84%",
        padding: "7px 11px",
        borderRadius: 10,
        background: "rgba(64,150,255,0.20)",
        border: "1px solid rgba(64,150,255,0.35)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      },
      bubbleAi: {
        alignSelf: "flex-start",
        maxWidth: "90%",
        padding: "7px 11px",
        borderRadius: 10,
        background: "rgba(127,127,127,0.12)",
        border: "1px solid rgba(127,127,127,0.22)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      },
      toolLine: {
        alignSelf: "flex-start",
        fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: 11.5,
        color: "rgba(190,145,60,1)",
        padding: "1px 0 1px 8px",
        borderLeft: "2px solid rgba(190,145,60,0.45)",
        wordBreak: "break-all",
      },
      toolOut: {
        alignSelf: "stretch",
        margin: 0,
        padding: "6px 8px",
        borderRadius: 6,
        background: "rgba(0,0,0,0.16)",
        fontSize: 11.5,
        lineHeight: 1.45,
        fontFamily: "ui-monospace, Consolas, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 200,
        overflow: "auto",
      },
      chatFoot: {
        borderTop: "1px solid rgba(127,127,127,0.18)",
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      },
      textarea: {
        width: "100%",
        minHeight: 54,
        maxHeight: 180,
        resize: "vertical",
        boxSizing: "border-box",
        font: "inherit",
        fontSize: 13,
        lineHeight: 1.5,
        padding: "6px 8px",
        borderRadius: 6,
        border: "1px solid rgba(150,180,220,0.38)",
        background: "rgba(8,20,36,0.78)",
        color: "#eaf2ff",
        colorScheme: "dark",
        outline: "none",
      },
      // ── 对话里的 markdown
      mdP: { margin: "0 0 6px" },
      mdList: { margin: "0 0 6px", paddingLeft: 20 },
      mdH: { margin: "10px 0 4px", fontSize: 13.5, fontWeight: 600 },
      mdCode: {
        padding: "1px 4px",
        borderRadius: 4,
        background: "rgba(127,127,127,0.22)",
        fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: 12,
      },
      mdLink: { color: "#6cb6ff" },
      mdQuote: {
        margin: "0 0 6px",
        paddingLeft: 8,
        borderLeft: "2px solid rgba(127,127,127,0.45)",
        color: "rgba(178,196,220,0.9)",
      },
      mdHr: { margin: "8px 0", border: "none", borderTop: "1px solid rgba(127,127,127,0.3)" },
      mdTable: { borderCollapse: "collapse", margin: "0 0 6px", fontSize: 12 },
      mdTh: {
        border: "1px solid rgba(127,127,127,0.35)",
        padding: "2px 6px",
        background: "rgba(127,127,127,0.14)",
        textAlign: "left",
      },
      mdTd: { border: "1px solid rgba(127,127,127,0.35)", padding: "2px 6px" },

      // ── 代码块（带语言标签和复制按钮）
      codeBlock: {
        margin: "0 0 6px",
        borderRadius: 6,
        border: "1px solid rgba(127,127,127,0.28)",
        background: "rgba(0,0,0,0.28)",
        overflow: "hidden",
      },
      codeHead: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        fontSize: 11,
        color: "rgba(178,196,220,0.85)",
        borderBottom: "1px solid rgba(127,127,127,0.22)",
        background: "rgba(127,127,127,0.10)",
      },
      codeBody: {
        margin: 0,
        padding: "8px 10px",
        fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: "pre",
        overflowX: "auto",
        maxHeight: 320,
      },

      // ── 思考过程（可折叠，流式时自动展开）
      thinkBox: {
        alignSelf: "stretch",
        border: "1px solid rgba(127,127,127,0.24)",
        borderLeft: "2px solid rgba(150,130,235,0.65)",
        borderRadius: 6,
        background: "rgba(127,127,127,0.07)",
        overflow: "hidden",
      },
      thinkHead: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        fontSize: 11.5,
        cursor: "pointer",
        color: "rgba(184,200,224,0.92)",
        userSelect: "none",
      },
      thinkBody: {
        margin: 0,
        padding: "2px 10px 8px",
        fontSize: 12,
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "rgba(178,196,220,0.82)",
        maxHeight: 260,
        overflowY: "auto",
      },

      // ── 工具调用卡片
      toolCard: {
        alignSelf: "stretch",
        border: "1px solid rgba(190,145,60,0.32)",
        borderRadius: 6,
        background: "rgba(190,145,60,0.08)",
        overflow: "hidden",
      },
      toolHead: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        fontSize: 11.5,
        cursor: "pointer",
        color: "rgba(214,172,92,1)",
        userSelect: "none",
        fontFamily: "ui-monospace, Consolas, monospace",
        minWidth: 0,
      },
      // 抬头那行人话：只占一行，长了用省略号，全文点开才给。
      toolLabel: {
        flex: "1 1 auto",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      // 右侧小字：收起状态下至少知道这次输出有多少。
      toolMeta: { flex: "0 0 auto", opacity: 0.62, fontSize: 10.5 },
      toolBody: {
        margin: 0,
        padding: "6px 10px 8px",
        fontSize: 11.5,
        lineHeight: 1.45,
        fontFamily: "ui-monospace, Consolas, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 260,
        overflow: "auto",
        background: "rgba(0,0,0,0.20)",
      },

      // ── 助手消息（头像 + 内容列）
      msgRow: { display: "flex", gap: 8, alignItems: "flex-start", alignSelf: "stretch" },
      avatar: {
        flex: "0 0 auto",
        width: 22,
        height: 22,
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        background: "rgba(64,150,255,0.22)",
        border: "1px solid rgba(64,150,255,0.38)",
      },
      msgCol: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 },
      caret: {
        display: "inline-block",
        width: 6,
        height: 13,
        marginLeft: 2,
        verticalAlign: "-2px",
        background: "rgba(120,190,255,0.9)",
        animation: "dshre-blink 1s steps(1) infinite",
      },

      // ── 远端终端
      termRoot: {
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        background: "rgba(6,14,24,0.92)",
      },
      termHead: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        fontSize: 12,
        borderBottom: "1px solid rgba(127,127,127,0.22)",
        background: "rgba(8,20,36,0.72)",
      },
      termLog: {
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "6px 10px",
        fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        color: "#d6e4f5",
      },
      termLine: { whiteSpace: "pre-wrap", wordBreak: "break-word" },
      termEcho: { color: "#eaf2ff" },
      termOut: { color: "#cfe0f2" },
      termErr: { color: "#ff9d9d" },
      termMeta: { color: "rgba(127,127,127,1)" },
      termInputRow: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderTop: "1px solid rgba(127,127,127,0.22)",
        fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: 12,
      },
      termInputBox: {
        flex: 1,
        minWidth: 0,
        border: "none",
        outline: "none",
        background: "transparent",
        color: "#eaf2ff",
        font: "inherit",
        padding: "2px 0",
      },
      /** 小号文字按钮（代码块复制、终端清屏这类）。 */
      miniButton: {
        flex: "0 0 auto",
        border: "none",
        background: "transparent",
        color: "rgba(140,190,255,0.95)",
        cursor: "pointer",
        fontSize: 11,
        padding: "0 2px",
        font: "inherit",
      },
      splitH: {
        flex: "0 0 auto",
        height: 6,
        cursor: "row-resize",
        touchAction: "none",
        backgroundImage:
          "linear-gradient(to bottom, rgba(127,127,127,0) 2px, rgba(127,127,127,0.45) 2px, rgba(127,127,127,0.45) 3px, rgba(127,127,127,0) 3px)",
      },

      tabRow: { display: "flex", alignItems: "center", gap: 6, padding: "6px 10px 0" },
      tab: {
        padding: "3px 12px",
        borderRadius: "6px 6px 0 0",
        cursor: "pointer",
        fontSize: 12.5,
        border: "1px solid rgba(127,127,127,0.25)",
        borderBottom: "none",
        background: "transparent",
        color: "inherit",
      },
      tabActive: {
        padding: "3px 12px",
        borderRadius: "6px 6px 0 0",
        cursor: "pointer",
        fontSize: 12.5,
        border: "1px solid rgba(127,127,127,0.25)",
        borderBottom: "none",
        background: "rgba(127,127,127,0.16)",
      },
    };

    /**
     * 鼠标悬停高亮的行包装。
     *
     * 同时也是拖拽的把手：`draggable` 的行能把远端文件/目录拖出去，
     * 目录行自己还兼作「拖进来的落点」（`onDragOver` / `onDrop` 由调用方给）。
     */
    function Row(props) {
      const [hover, setHover] = react.useState(false);
      const selected = props.selected === true;
      const hoverStyle =
        hover && props.dropping !== true && selected !== true ? { background: "rgba(127,127,127,0.14)" } : null;
      return react.createElement(
        "div",
        {
          style: {
            ...S.row,
            ...hoverStyle,
            ...(selected ? S.rowSelected : null),
            ...(props.dropping === true ? S.rowDropping : null),
            ...props.style,
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: props.onClick,
          onDoubleClick: props.onDoubleClick,
          onContextMenu: props.onContextMenu,
          title: props.title,
          draggable: props.draggable === true,
          onDragStart: props.onDragStart,
          onDragEnd: props.onDragEnd,
          onDragOver: props.onDragOver,
          onDragLeave: props.onDragLeave,
          onDrop: props.onDrop,
        },
        props.children,
      );
    }

    /**
     * 传输抽屉：右下角浮层，列出正在跑和刚跑完的传输。
     *
     * 进度全靠轮询宿主侧的 `/job`（大文件要传很久，不能靠一个长连接等结果）；
     * 「字节流兜底上传」是客户端自己攒的伪任务，形状与宿主任务一致，所以同一套渲染。
     */
    function TransferDrawer(props) {
      const jobs = props.jobs ?? [];
      if (jobs.length === 0 || props.open === false) return null;
      const running = jobs.filter((job) => job.state === "running").length;
      return react.createElement(
        "div",
        { style: S.drawer },
        react.createElement(
          "div",
          { style: S.drawerHead },
          react.createElement("span", null, running > 0 ? `传输 · ${running} 个进行中` : "传输"),
          react.createElement("div", { style: S.grow }),
          react.createElement(
            "button",
            { type: "button", style: S.button, onClick: props.onClose, title: "收起传输面板（任务继续在后台跑）" },
            "收起",
          ),
        ),
        jobs.map((job) => {
          const total = Number(job.total) || 0;
          const bytes = Number(job.bytes) || 0;
          const pct =
            job.state === "running"
              ? total > 0
                ? Math.min(100, Math.round((bytes / total) * 100))
                : 8
              : 100;
          const failedItems = (job.items ?? []).filter((item) => item.state === "failed");
          return react.createElement(
            "div",
            { key: job.id, style: S.jobCard },
            react.createElement(
              "div",
              { style: S.jobTitle },
              react.createElement("span", null, JOB_KIND_ICON[job.kind] ?? "⇅"),
              react.createElement(
                "span",
                { style: S.jobName, title: `${job.title}${job.target ? `\n→ ${job.target}` : ""}` },
                job.title || "传输",
              ),
              react.createElement(
                "span",
                { style: { ...S.jobMeta, flex: "0 0 auto" } },
                JOB_STATE_LABEL[job.state] ?? job.state,
              ),
            ),
            react.createElement(
              "div",
              { style: S.progress },
              react.createElement("div", {
                style: {
                  ...S.progressFill,
                  width: `${pct}%`,
                  background: job.state === "failed" ? "rgba(230,120,120,0.9)" : S.progressFill.background,
                },
              }),
            ),
            react.createElement(
              "div",
              { style: S.jobMeta },
              react.createElement("span", null, job.phase || ""),
              total > 0 ? react.createElement("span", null, `${fmtSize(bytes)} / ${fmtSize(total)}`) : null,
              job.target ? react.createElement("span", { style: { wordBreak: "break-all" } }, `→ ${job.target}`) : null,
            ),
            failedItems.length > 0
              ? react.createElement(
                  "div",
                  { key: "err", style: S.jobError },
                  failedItems
                    .slice(0, 3)
                    .map((item) => `${item.label}: ${item.error || "失败"}`)
                    .join("\n"),
                )
              : null,
            job.message ? react.createElement("div", { style: S.jobError }, job.message) : null,
            react.createElement(
              "div",
              { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
              job.state === "running"
                ? react.createElement(
                    "button",
                    { type: "button", style: S.button, onClick: () => props.onCancel(job.id) },
                    "取消",
                  )
                : null,
              job.state === "done" && job.openPath
                ? react.createElement(
                    "button",
                    { type: "button", style: S.button, onClick: () => props.onReveal(job.openPath) },
                    "在资源管理器中显示",
                  )
                : null,
              job.state !== "running"
                ? react.createElement(
                    "button",
                    { type: "button", style: S.button, onClick: () => props.onDismiss(job.id) },
                    "清除",
                  )
                : null,
            ),
          );
        }),
      );
    }

    // ───────────────────────────────────────────────── 连接管理（删除设备）

    /**
     * 连接管理浮层：列出全部连接，逐条可删；删掉的落到下面「已删除」区，可以恢复。
     *
     * 故意不带 hook —— 它挂在 ExplorerPanel 的渲染树里，多一个 hook 就会把后面
     * ChatPanel 的槽位整体顶偏，测试替身就得跟着改。
     */
    function ConnectionManager(props) {
      if (props.open !== true) return null;
      const connections = props.connections ?? [];
      const hidden = props.hidden ?? [];
      const rowOf = (item, where) => {
        const confirming = props.pendingDelete === item.id;
        const address = item.user ? `${item.user}@${item.host}` : item.host || item.id;
        const origin = where === "hidden" ? "已删除" : item.readOnly ? "来自 ~/.ssh/config" : "自建连接";
        return react.createElement(
          "div",
          { key: `${where}:${item.id}`, style: S.connRow },
          react.createElement(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            react.createElement("div", { style: S.connName, title: item.id }, item.name || item.host || item.id),
            react.createElement("div", { style: S.connMeta }, [address, origin].filter((part) => part && part.length > 0).join(" · ")),
          ),
          where === "hidden"
            ? react.createElement(
                "button",
                { type: "button", style: S.button, onClick: () => props.onRestore(item), title: "放回连接清单" },
                "恢复",
              )
            : confirming
              ? react.createElement(
                  "span",
                  { style: { display: "flex", gap: 6, flex: "0 0 auto" } },
                  react.createElement(
                    "button",
                    { type: "button", style: S.dangerButton, onClick: () => props.onDelete(item) },
                    "确认删除",
                  ),
                  react.createElement("button", { type: "button", style: S.button, onClick: () => props.onCancelDelete() }, "取消"),
                )
              : react.createElement(
                  "button",
                  {
                    type: "button",
                    style: S.dangerButton,
                    onClick: () => props.onAskDelete(item.id),
                    title: item.readOnly ? "从清单里隐藏（不改 ~/.ssh/config）" : "删除这个自建连接",
                  },
                  "删除",
                ),
        );
      };
      return react.createElement(
        "div",
        {
          style: S.managerBackdrop,
          onClick: (event) => {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        react.createElement(
          "div",
          { style: S.managerCard },
          react.createElement(
            "div",
            { style: S.drawerHead },
            react.createElement("span", null, `连接管理 · ${connections.length} 台`),
            react.createElement("div", { style: S.grow }),
            react.createElement("button", { type: "button", style: S.button, onClick: props.onClose }, "关闭"),
          ),
          react.createElement(
            "div",
            { style: S.connHint },
            "删掉不再需要的设备。来自 ~/.ssh/config 的主机只会从清单里隐藏（配置文件不动），自建连接会真删；删掉的都能在下面恢复。",
          ),
          connections.length === 0
            ? react.createElement("div", { style: S.hint }, "还没有连接，点「＋ 新建连接」加一台。")
            : connections.map((item) => rowOf(item, "list")),
          hidden.length > 0
            ? react.createElement("div", { key: "hidden-head", style: S.connGroup }, `已删除（${hidden.length}）`)
            : null,
          ...hidden.map((item) => rowOf(item, "hidden")),
        ),
      );
    }

    // ───────────────────────────────────────────────── 活动栏图标

    /** 活动栏图标（服务器 + 文件）。 */
    function ExplorerIcon(props) {
      const size = (props && props.size) || 18;
      return react.createElement(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        react.createElement("rect", { key: "a", x: 2.5, y: 4, width: 19, height: 7, rx: 1.6 }),
        react.createElement("rect", { key: "b", x: 2.5, y: 13, width: 19, height: 7, rx: 1.6 }),
        react.createElement("circle", { key: "c", cx: 6.2, cy: 7.5, r: 0.9, fill: "currentColor" }),
        react.createElement("circle", { key: "d", cx: 6.2, cy: 16.5, r: 0.9, fill: "currentColor" }),
      );
    }

    // ───────────────────────────────────────────────── 新建 / 编辑连接表单

    const AUTH_LABEL = {
      auto: "自动（先试密钥，再试密码）",
      key: "只用密钥",
      password: "只用密码",
      agent: "ssh-agent",
    };

    function authLabel(value) {
      return AUTH_LABEL[value] ?? AUTH_LABEL.auto;
    }

    const EMPTY_DRAFT = {
      name: "",
      host: "",
      port: "",
      user: "",
      identityFile: "",
      authType: "auto",
      password: "",
    };

    function ConnectionForm(props) {
      const start = props.initial;
      const [draft, setDraft] = react.useState(
        start
          ? {
              name: start.name ?? "",
              host: start.host ?? "",
              port: start.port === undefined || start.port === null ? "" : String(start.port),
              user: start.user ?? "",
              identityFile: start.identityFile ?? "",
              authType: start.authType ?? "auto",
              password: "",
            }
          : { ...EMPTY_DRAFT },
      );
      const [busy, setBusy] = react.useState(false);

      const field = (key) => (event) => setDraft({ ...draft, [key]: event.target.value });

      const submit = async () => {
        if (draft.host.trim().length === 0) return;
        setBusy(true);
        try {
          const connection = { ...draft };
          if (start) connection.id = start.id;
          // 口令留空表示「不改动」，所以不要把空串传过去。
          if (connection.password.length === 0) delete connection.password;
          const answer = await apiPost("connections", { action: "save", connection });
          if (answer.ok) {
            setDraft({ ...EMPTY_DRAFT });
            props.onSaved(answer.connection);
          } else {
            props.onError(answer.error || "保存失败");
          }
        } catch (error) {
          props.onError(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      const label = (text) => react.createElement("span", { key: `l-${text}`, style: { color: "rgba(178,196,220,0.92)", fontSize: 12 } }, text);
      const row = (key, text, placeholder) =>
        react.createElement(
          "div",
          { key, style: S.formRow },
          label(text),
          react.createElement("input", {
            style: inputStyle(),
            value: draft[key],
            placeholder,
            onChange: field(key),
          }),
        );

      return react.createElement(
        "div",
        { style: S.form },
        react.createElement(
          "span",
          { key: "title", style: S.formTitle },
          start ? `编辑「${start.name}」` : "新建连接",
        ),
        row("name", "名称", "ubuntu"),
        row("host", "主机", "192.168.111.129"),
        row("port", "端口", "22（留空默认）"),
        row("user", "用户名", "admin"),
        reflectAuthType(draft.authType, row, label),
        react.createElement(
          "div",
          { key: "auth-picker", style: S.formRow },
          label("认证方式"),
          react.createElement(
            "select",
            { style: selectStyle(), value: draft.authType, onChange: field("authType") },
            Object.keys(AUTH_LABEL).map((value) =>
              react.createElement("option", { key: value, value, style: optionStyle() }, AUTH_LABEL[value]),
            ),
          ),
        ),
        react.createElement(
          "div",
          { key: "pw", style: S.formRow },
          label("密码"),
          react.createElement("input", {
            style: inputStyle(),
            type: "password",
            value: draft.password,
            placeholder: start && start.hasPassword ? "已保存，留空则不改动" : "留空则不存密码",
            onChange: field("password"),
          }),
        ),
        react.createElement(
          "span",
          { key: "note", style: S.formNote },
          "密码用 Windows DPAPI 加密后存在本机，只有当前 Windows 账户能解开；不填就靠密钥或 ssh-agent。",
        ),
        react.createElement(
          "div",
          { key: "actions", style: S.inputRow },
          react.createElement(
            "button",
            { style: { ...S.button, ...S.buttonPrimary }, disabled: busy, onClick: submit },
            busy ? "保存中…" : start ? "保存修改" : "保存连接",
          ),
          react.createElement("button", { style: S.button, onClick: props.onCancel }, "取消"),
        ),
      );
    }

    /** 只用密钥时不显示私钥输入框才怪 —— 所以四种方式都显示私钥，只是提示语不同。 */
    function reflectAuthType(authType, row, label) {
      const hint =
        authType === "password"
          ? "留空即可（只用密码，不会去试密钥）"
          : authType === "agent"
            ? "留空即可（由 ssh-agent 提供密钥）"
            : "留空用 ~/.ssh/id_ed25519";
      return row("identityFile", "私钥", hint);
    }

    // ───────────────────────────────────────────────── 设置 / 清除口令

    function SecretDialog(props) {
      const [value, setValue] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const target = props.connection;

      const post = async (body, fallback) => {
        setBusy(true);
        try {
          const answer = await apiPost("connections", body);
          if (answer.ok) props.onDone();
          else props.onError(answer.error || fallback);
        } catch (error) {
          props.onError(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      return react.createElement(
        "div",
        { style: S.form },
        react.createElement(
          "span",
          { style: S.formTitle },
          `为「${target.name}」设置密码 —— ${target.user ? `${target.user}@` : ""}${target.host}`,
        ),
        react.createElement(
          "span",
          { style: S.formNote },
          "登录密码或密钥口令都可以。这台主机用你自己的，不会影响其它连接。\n密码用 Windows DPAPI 加密后存在本机，只有当前 Windows 账户能解开。",
        ),
        react.createElement(
          "div",
          { style: S.formRow },
          react.createElement(
            "span",
            { style: { color: "rgba(178,196,220,0.92)", fontSize: 12 } },
            "密码",
          ),
          react.createElement("input", {
            style: inputStyle(),
            type: "password",
            value,
            placeholder: "登录密码 / 密钥口令",
            onChange: (event) => setValue(event.target.value),
          }),
        ),
        react.createElement(
          "div",
          { style: S.inputRow },
          react.createElement(
            "button",
            {
              style: { ...S.button, ...S.buttonPrimary },
              disabled: busy || value.length === 0,
              onClick: () => void post({ action: "secret", id: target.id, password: value }, "保存失败"),
            },
            busy ? "保存中…" : "保存密码",
          ),
          target.hasPassword
            ? react.createElement(
                "button",
                {
                  style: S.button,
                  disabled: busy,
                  onClick: () => void post({ action: "secret", id: target.id, clear: true }, "清除失败"),
                },
                "清除密码",
              )
            : null,
          react.createElement("button", { style: S.button, onClick: props.onCancel }, "取消"),
        ),
      );
    }

    // ───────────────────────────────────────────────── 可拉伸面板

    const CHAT_WIDTH_KEY = "dsh-ssh-explorer.chatWidth";
    const LIST_WIDTH_KEY = "dsh-ssh-explorer.listWidth";
    const CHAT_WIDTH_DEFAULT = 420;
    const LIST_WIDTH_DEFAULT = 480;

    /** 读回上次拖出来的宽度；越界或读不到就退回落默认值。 */
    function readStoredWidth(key, fallback, min, max) {
      try {
        if (typeof window === "undefined" || !window.localStorage) return fallback;
        const value = Number(window.localStorage.getItem(key));
        if (!Number.isFinite(value) || value <= 0) return fallback;
        return Math.min(max, Math.max(min, Math.round(value)));
      } catch (err) {
        return fallback;
      }
    }

    /** 记住拖出来的宽度，下次开面板还是这个宽度。 */
    function writeStoredWidth(key, value) {
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem(key, String(value));
        }
      } catch (err) {
        /* 隐私模式 / 配额满：记不住就算了，不影响使用 */
      }
    }

    /**
     * 竖直分隔条。按住左右拖，改相邻面板的宽度。
     *
     * 方向按「直接操作」定：分隔条就是两个面板的边界，**边界往哪边移，面板就往哪边长**。
     * - invert=false（受控面板在分隔条**左边**，如文件列表）：往右拖＝变宽
     * - invert=true （受控面板在分隔条**右边**，如 AI 对话栏）：往左拖＝变宽
     */
    function VSplit(props) {
      const value = props.value;
      const min = props.min;
      const max = props.max;
      const invert = props.invert === true;
      const onChange = props.onChange;

      const onMouseDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startValue = value;
        const move = (moveEvent) => {
          const delta = invert ? startX - moveEvent.clientX : moveEvent.clientX - startX;
          onChange(Math.min(max, Math.max(min, Math.round(startValue + delta))));
        };
        const setBodyCursor = (on) => {
          if (typeof document === "undefined" || !document.body || !document.body.style) return;
          document.body.style.userSelect = on ? "none" : "";
          document.body.style.cursor = on ? "col-resize" : "";
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          setBodyCursor(false);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        setBodyCursor(true);
      };

      return react.createElement("div", {
        style: S.splitV,
        onMouseDown,
        title: invert ? "按住左右拖动，调整宽度（往左拖变宽）" : "按住左右拖动，调整宽度（往右拖变宽）",
        role: "separator",
        "aria-orientation": "vertical",
      });
    }

    // ───────────────────────────────────────────────── AI 对话面板

    const CHAT_PLACEHOLDER = "让它在远端写代码、跑命令、改文件…（Enter 发送，Shift+Enter 换行）";

    /** 工具卡抬头最多显示多少字符（超了截断，全文在 title / 展开里）。 */
    const TOOL_LINE_MAX = 72;

    /** 把任意文本压成一行：空白折成单个空格，超长截断加省略号。 */
    function oneLine(text, limit) {
      const flat = String(text ?? "").replace(/\s+/g, " ").trim();
      const max = limit > 0 ? limit : TOOL_LINE_MAX;
      return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
    }

    /** 把一次工具调用渲染成一行人话。默认只用一行，全文靠 title / 点开。 */
    function toolLineOf(step, limit) {
      const args = step && step.args && typeof step.args === "object" ? step.args : {};
      const name = step && step.name ? step.name : "";
      if (name === "ssh_exec") return `$ ${oneLine(args.command, limit)}`;
      if (name === "ssh_list") return `列目录 ${oneLine(args.path, limit)}`;
      if (name === "ssh_read") return `读文件 ${oneLine(args.path, limit)}`;
      if (name === "ssh_write") return `写文件 ${oneLine(args.path, limit)}（${String(args.content ?? "").length} 字符）`;
      return name || "工具调用";
    }

    // ───────────────────────────────────────────────── 回复里的 markdown

    /** 行内语法：`code` / **粗** / *斜* / [文字](链接)。只做对话里真会出现的几种。 */
    function inlineNodes(text, keyBase) {
      const out = [];
      const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
      let last = 0;
      let hit;
      let n = 0;
      while ((hit = pattern.exec(text)) !== null) {
        if (hit.index > last) out.push(text.slice(last, hit.index));
        const token = hit[0];
        const key = `${keyBase}-${n}`;
        n += 1;
        if (token.startsWith("`")) {
          out.push(react.createElement("code", { key, style: S.mdCode }, token.slice(1, -1)));
        } else if (token.startsWith("**")) {
          out.push(react.createElement("strong", { key }, token.slice(2, -2)));
        } else if (token.startsWith("*")) {
          out.push(react.createElement("em", { key }, token.slice(1, -1)));
        } else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
          out.push(
            react.createElement(
              "a",
              { key, href: link[2], target: "_blank", rel: "noreferrer", style: S.mdLink },
              link[1],
            ),
          );
        }
        last = hit.index + token.length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }

    /** 行内渲染；整段没有语法时直接返回字符串，少一层包装。 */
    function mdText(text, keyBase) {
      const nodes = inlineNodes(String(text ?? ""), keyBase);
      return nodes.length === 1 && typeof nodes[0] === "string" ? nodes[0] : nodes;
    }

    /** 一段代码，带语言标签与复制按钮。 */
    function CodeBlock(props) {
      const [copied, setCopied] = react.useState(false);
      const copy = () => {
        const text = String(props.code ?? "");
        const done = () => {
          setCopied(true);
          if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
            window.setTimeout(() => setCopied(false), 1200);
          }
        };
        const fallback = () => {
          try {
            const area = document.createElement("textarea");
            area.value = text;
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            document.body.removeChild(area);
            done();
          } catch (err) {
            setCopied(false);
          }
        };
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, fallback);
            return;
          }
        } catch (err) {
          /* 剪贴板 API 不可用，走下面那条路 */
        }
        fallback();
      };
      return react.createElement(
        "div",
        { style: S.codeBlock },
        react.createElement(
          "div",
          { style: S.codeHead },
          react.createElement("span", null, props.lang && props.lang.length > 0 ? props.lang : "代码"),
          react.createElement("div", { style: S.grow }),
          react.createElement("button", { style: S.miniButton, onClick: copy, type: "button" }, copied ? "已复制" : "复制"),
        ),
        react.createElement("pre", { style: S.codeBody }, String(props.code ?? "")),
      );
    }

    /**
     * 极简 markdown → React 节点。只覆盖对话里真会出现的语法：围栏代码块、行内代码、
     * 粗体/斜体、标题、无序/有序列表、引用、分隔线、表格。
     * 不引第三方库、不用 innerHTML —— 插件是零依赖单文件，也顺手避开注入风险。
     */
    function markdownNodes(text) {
      const out = [];
      const lines = String(text ?? "").split("\n");
      let key = 0;
      let para = [];
      let list = null;

      const flushPara = () => {
        if (para.length === 0) return;
        const body = para.join("\n");
        para = [];
        key += 1;
        out.push(react.createElement("p", { key: `p${key}`, style: S.mdP }, mdText(body, `p${key}`)));
      };
      const flushList = () => {
        if (!list) return;
        const items = list.items;
        const ordered = list.ordered;
        list = null;
        key += 1;
        out.push(
          react.createElement(
            ordered ? "ol" : "ul",
            { key: `l${key}`, style: S.mdList },
            ...items.map((item, index) =>
              react.createElement("li", { key: index }, mdText(item, `l${key}-${index}`)),
            ),
          ),
        );
      };

      let i = 0;
      while (i < lines.length) {
        const line = lines[i];

        // 围栏代码块
        const fence = /^\s*```(\S*)\s*$/.exec(line);
        if (fence) {
          flushPara();
          flushList();
          const lang = fence[1] || "";
          const body = [];
          i += 1;
          while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
            body.push(lines[i]);
            i += 1;
          }
          if (i < lines.length) i += 1; // 吃掉闭合围栏
          key += 1;
          out.push(react.createElement(CodeBlock, { key: `c${key}`, lang, code: body.join("\n") }));
          continue;
        }

        // 表格：| a | b | 后面跟一行 | --- | --- |
        if (
          /^\s*\|.*\|\s*$/.test(line) &&
          i + 1 < lines.length &&
          /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])
        ) {
          flushPara();
          flushList();
          const cellsOf = (row) =>
            row
              .trim()
              .replace(/^\|/, "")
              .replace(/\|$/, "")
              .split("|")
              .map((cell) => cell.trim());
          const head = cellsOf(line);
          i += 2;
          const rows = [];
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
            rows.push(cellsOf(lines[i]));
            i += 1;
          }
          key += 1;
          const tableKey = key;
          out.push(
            react.createElement(
              "table",
              { key: `tb${tableKey}`, style: S.mdTable },
              react.createElement(
                "thead",
                null,
                react.createElement(
                  "tr",
                  null,
                  ...head.map((cell, ci) =>
                    react.createElement("th", { key: ci, style: S.mdTh }, mdText(cell, `th${tableKey}-${ci}`)),
                  ),
                ),
              ),
              react.createElement(
                "tbody",
                null,
                ...rows.map((row, ri) =>
                  react.createElement(
                    "tr",
                    { key: ri },
                    ...row.map((cell, ci) =>
                      react.createElement("td", { key: ci, style: S.mdTd }, mdText(cell, `td${tableKey}-${ri}-${ci}`)),
                    ),
                  ),
                ),
              ),
            ),
          );
          continue;
        }

        // 分隔线
        if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
          flushPara();
          flushList();
          key += 1;
          out.push(react.createElement("hr", { key: `hr${key}`, style: S.mdHr }));
          i += 1;
          continue;
        }

        // 标题（往下压三级，免得在窄栏里过大）
        const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          flushPara();
          flushList();
          key += 1;
          const tag = `h${Math.min(6, heading[1].length + 2)}`;
          out.push(react.createElement(tag, { key: `h${key}`, style: S.mdH }, mdText(heading[2], `h${key}`)));
          i += 1;
          continue;
        }

        // 引用
        if (/^\s*>\s?/.test(line)) {
          flushPara();
          flushList();
          const body = [line.replace(/^\s*>\s?/, "")];
          i += 1;
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            body.push(lines[i].replace(/^\s*>\s?/, ""));
            i += 1;
          }
          key += 1;
          out.push(
            react.createElement(
              "blockquote",
              { key: `q${key}`, style: S.mdQuote },
              mdText(body.join("\n"), `q${key}`),
            ),
          );
          continue;
        }

        // 列表
        const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (bullet) {
          flushPara();
          const ordered = /^\d/.test(bullet[1]);
          if (!list || list.ordered !== ordered) {
            flushList();
            list = { ordered, items: [] };
          }
          list.items.push(bullet[2]);
          i += 1;
          continue;
        }

        // 空行收段，其余归入段落
        if (/^\s*$/.test(line)) {
          flushPara();
          flushList();
          i += 1;
          continue;
        }
        para.push(line);
        i += 1;
      }
      flushPara();
      flushList();
      return out;
    }

    /** 回复正文。live=true（还在流式）时末尾挂一个闪烁光标。 */
    function MarkdownBody(props) {
      const nodes = markdownNodes(props.text);
      if (props.live === true) {
        nodes.push(react.createElement("span", { key: "__caret", style: S.caret }));
      }
      return react.createElement("div", { style: { minWidth: 0 } }, ...nodes);
    }

    /** 思考过程。流式时自动展开；用户手动点过之后就不再自动收放。 */
    function ThinkingBlock(props) {
      const [manual, setManual] = react.useState(null);
      const live = props.live === true;
      const text = String(props.text ?? "");
      const open = manual === null ? live : manual;
      const head = live ? "思考中…" : `已深度思考（${text.length} 字）`;
      return react.createElement(
        "div",
        { style: S.thinkBox },
        react.createElement(
          "div",
          {
            style: S.thinkHead,
            role: "button",
            title: open ? "收起思考过程" : "展开思考过程",
            onClick: () => setManual(!open),
          },
          react.createElement("span", null, open ? "▾" : "▸"),
          react.createElement("span", null, live ? "🧠 思考中…" : `🧠 ${head}`),
        ),
        open && text.length > 0 ? react.createElement("pre", { style: S.thinkBody }, text) : null,
      );
    }

    /** 一次工具调用：抬头只占一行（超长省略号），点开才看全文、参数与输出。失败时边框转红。 */
    function ToolCard(props) {
      const [open, setOpen] = react.useState(false);
      const step = props.step && typeof props.step === "object" ? props.step : {};
      const args = step.args && typeof step.args === "object" ? step.args : {};
      const out = typeof step.output === "string" ? step.output : "";
      const bad = step.ok === false;
      const fullCommand = typeof args.command === "string" ? args.command : "";
      const argLines = Object.entries(args)
        .filter(([name]) => name !== "content" && name !== "command")
        .map(([name, value]) => `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
      if (typeof args.content === "string") argLines.push(`content: ${args.content.length} 字符`);
      const outLines = out.length > 0 ? out.replace(/\n+$/, "").split("\n").length : 0;
      return react.createElement(
        "div",
        { style: bad ? { ...S.toolCard, borderColor: "rgba(220,90,90,0.5)" } : S.toolCard },
        react.createElement(
          "div",
          {
            style: S.toolHead,
            role: "button",
            title: open
              ? "收起"
              : `${toolLineOf(step, 400)}${outLines > 0 ? `\n\n（${outLines} 行输出，点开看全文）` : "\n\n点开看全文"}`,
            onClick: () => setOpen(!open),
          },
          react.createElement("span", null, open ? "▾" : "▸"),
          react.createElement("span", { style: S.toolLabel }, `${bad ? "✖" : "🔧"} ${toolLineOf(step)}`),
          outLines > 0 ? react.createElement("span", { style: S.toolMeta }, `${outLines} 行`) : null,
        ),
        open
          ? react.createElement(
              "div",
              null,
              fullCommand.length > 0 ? react.createElement("pre", { style: S.toolBody }, `$ ${fullCommand}`) : null,
              argLines.length > 0 ? react.createElement("pre", { style: S.toolBody }, argLines.join("\n")) : null,
              out.length > 0 ? react.createElement("pre", { style: S.toolBody }, out) : null,
            )
          : null,
      );
    }

    /** AI 对话面板：跟模型来回，模型自己调 SSH 工具。docked=true 时是右侧停靠栏。 */
    function ChatPanel(props) {
      const connection = props.connection;
      const path = props.path;
      const onBack = props.onBack;
      const docked = props.docked === true;
      const [messages, setMessages] = react.useState([]);
      const [input, setInput] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState("");
      const [steps, setSteps] = react.useState([]);
      const [model, setModel] = react.useState("");
      const [models, setModels] = react.useState([]);
      const [modelGroups, setModelGroups] = react.useState([]);
      const [modelExtra, setModelExtra] = react.useState([]);
      const [chosen, setChosen] = react.useState("");
      const [saveNote, setSaveNote] = react.useState("");

      const scroller = react.useRef(null);
      react.useEffect(() => {
        const node = scroller.current;
        if (node && typeof node.scrollTop === "number") node.scrollTop = node.scrollHeight;
      });

      /**
       * 发一轮。优先走 SSE 流式（边收边渲染思考和正文，观感跟 DSH 本体一致）；
       * 宿主是旧版、不给 `text/event-stream` 时自动退回落一次性 JSON。
       */
      const send = react.useCallback(async () => {
        const text = input.trim();
        if (text.length === 0 || busy) return;
        if (!connection) {
          setError("先在「文件」页选一个连接，再用 AI 对话");
          return;
        }
        const history = [];
        for (const item of messages) {
          if (item.role === "user" || item.role === "assistant") {
            history.push({ role: item.role, content: String(item.content ?? "") });
          }
        }
        history.push({ role: "user", content: text });
        setMessages(messages.concat([{ role: "user", content: text }]));
        setInput("");
        setBusy(true);
        setError("");
        setSteps([]);
        setLiveItems([]);
        setLiveThink("");
        const abort = typeof AbortController === "function" ? new AbortController() : null;
        abortRef.current = abort;
        try {
          const response = await fetch(`${API}/chat`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify({
              connectionId: connection.id,
              path,
              model: chosen,
              stream: true,
              messages: history,
            }),
            signal: abort ? abort.signal : undefined,
          });
          if (!response.ok || !response.body) {
            const detail = await response.text().catch(() => "");
            throw new Error(`HTTP ${response.status} ${String(detail).slice(0, 200)}`);
          }

          const ctype =
            response.headers && typeof response.headers.get === "function"
              ? String(response.headers.get("content-type") || "")
              : "";
          if (ctype.indexOf("text/event-stream") < 0) {
            // 旧版宿主：退回一次性 JSON。
            const res = await response.json();
            if (res && res.ok) {
              setMessages((prev) => prev.concat([{ role: "assistant", content: String(res.reply ?? "") }]));
              setSteps(Array.isArray(res.steps) ? res.steps : []);
              if (res.model) setModel(String(res.model));
            } else {
              setError((res && res.error) || "请求失败");
              if (res && Array.isArray(res.steps) && res.steps.length > 0) setSteps(res.steps);
            }
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";
          let think = "";
          let items = [];
          let boundary = true;
          let finished = null;
          const sync = () => setLiveItems(items.slice());
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let cut = buffer.indexOf("\n\n");
            while (cut >= 0) {
              const block = buffer.slice(0, cut);
              buffer = buffer.slice(cut + 2);
              cut = buffer.indexOf("\n\n");
              let name = "message";
              const data = [];
              for (const raw of block.split("\n")) {
                if (raw.startsWith("event:")) name = raw.slice(6).trim();
                else if (raw.startsWith("data:")) data.push(raw.slice(5).trim());
              }
              if (data.length === 0) continue;
              let payload = null;
              try {
                payload = JSON.parse(data.join("\n"));
              } catch (err) {
                continue;
              }
              if (name === "thinking") {
                think += String(payload.text ?? "");
                setLiveThink(think);
              } else if (name === "thinking-done") {
                think = String(payload.text ?? think);
                setLiveThink(think);
              } else if (name === "reply") {
                const delta = String(payload.text ?? "");
                const last = items.length > 0 ? items[items.length - 1] : null;
                if (boundary || !last || last.kind !== "text") {
                  items = items.concat([{ kind: "text", text: delta }]);
                  boundary = false;
                } else {
                  items = items.slice(0, -1).concat([{ kind: "text", text: last.text + delta }]);
                }
                sync();
              } else if (name === "round") {
                boundary = true;
              } else if (name === "tool-start") {
                items = items.concat([
                  { kind: "tool", step: { name: payload.name, args: payload.args, output: "" } },
                ]);
                boundary = true;
                sync();
              } else if (name === "tool") {
                const step = {
                  name: payload.name,
                  args: payload.args,
                  output: String(payload.output ?? ""),
                };
                const last = items.length > 0 ? items[items.length - 1] : null;
                if (last && last.kind === "tool" && last.step.output.length === 0 && last.step.name === step.name) {
                  items = items.slice(0, -1).concat([{ kind: "tool", step }]);
                } else {
                  items = items.concat([{ kind: "tool", step }]);
                }
                boundary = true;
                sync();
              } else if (name === "done") {
                finished = payload;
              } else if (name === "error") {
                throw new Error(String(payload.error || "请求失败"));
              }
            }
          }
          const reply = finished ? String(finished.reply ?? "") : "";
          const reasoning = finished ? String(finished.reasoning ?? think) : think;
          const doneSteps = finished && Array.isArray(finished.steps) ? finished.steps : [];
          if (reply.length === 0 && doneSteps.length === 0 && reasoning.length === 0) {
            setError("连接中断：没收到完整回复");
            return;
          }
          setMessages((prev) =>
            prev.concat([{ role: "assistant", content: reply, reasoning, steps: doneSteps }]),
          );
          if (finished && finished.model) setModel(String(finished.model));
        } catch (err) {
          const message = String(err && err.message ? err.message : err);
          if (message.indexOf("abort") < 0 && message.indexOf("Abort") < 0) setError(message);
        } finally {
          abortRef.current = null;
          setBusy(false);
          setLiveItems([]);
          setLiveThink("");
        }
      }, [input, busy, connection, messages, path, chosen]);

      // 拉一次可用模型清单。宿主会优先给「设置 → 模型」里配过的提供商与模型（分组），
      // 再附上网关有、但没配进 DSH 的那部分（平铺在最后一个组里）。
      react.useEffect(() => {
        let alive = true;
        apiGet("chat-models")
          .then((res) => {
            if (!alive || !res || !res.ok) return;
            const list = Array.isArray(res.models) ? res.models.map(String) : [];
            if (list.length === 0) return;
            const groups = (Array.isArray(res.providers) ? res.providers : [])
              .map((item) => ({
                name: String(item?.name ?? ""),
                models: (Array.isArray(item?.models) ? item.models : [])
                  .map((m) => ({ id: String(m?.id ?? ""), name: String(m?.name ?? m?.id ?? "") }))
                  .filter((m) => m.id.length > 0),
              }))
              .filter((item) => item.models.length > 0);
            const extra = (Array.isArray(res.extra) ? res.extra : []).map(String);
            setModels(list);
            setModelGroups(groups);
            setModelExtra(extra);
            setChosen((prev) =>
              prev.length > 0 && list.includes(prev) ? prev : String(res.current || list[0]),
            );
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      // 选模型：立刻生效（本次会话），同时落盘到 ~/.dsh/ssh-explorer/chat.json 当默认值。
      const pickModel = react.useCallback(
        (value) => {
          const next = String(value || "");
          if (next.length === 0) return;
          setChosen(next);
          setSaveNote("保存中…");
          apiPost("chat-config", { model: next })
            .then((res) => {
              setSaveNote(res && res.ok ? "已存为默认" : "本次有效");
            })
            .catch(() => {
              setSaveNote("本次有效");
            });
        },
        [],
      );

      // 流式渲染状态。故意放在所有原有 hook 之后，前面的槽位顺序保持不变。
      const [liveItems, setLiveItems] = react.useState([]);
      const [liveThink, setLiveThink] = react.useState("");
      const abortRef = react.useRef(null);

      /** 一条助手消息：思考块 → 工具卡 → markdown 正文。 */
      const assistantNode = (item, index) => {
        const blocks = [];
        if (typeof item.reasoning === "string" && item.reasoning.trim().length > 0) {
          blocks.push(react.createElement(ThinkingBlock, { key: `r${index}`, text: item.reasoning, live: false }));
        }
        const list = Array.isArray(item.steps) ? item.steps : [];
        list.forEach((step, si) => {
          blocks.push(react.createElement(ToolCard, { key: `s${index}-${si}`, step }));
        });
        if (String(item.content ?? "").length > 0) {
          blocks.push(react.createElement(MarkdownBody, { key: `b${index}`, text: item.content }));
        }
        if (blocks.length === 0) {
          blocks.push(react.createElement("div", { key: `e${index}`, style: S.hint }, "（无内容）"));
        }
        return react.createElement(
          "div",
          { key: `m${index}`, style: S.msgRow },
          react.createElement("div", { style: S.avatar }, "✦"),
          react.createElement("div", { style: S.msgCol }, ...blocks),
        );
      };

      const nodes = [];
      messages.forEach((item, index) => {
        if (item.role === "user") {
          nodes.push(react.createElement("div", { key: `m${index}`, style: S.bubbleUser }, item.content));
          return;
        }
        nodes.push(assistantNode(item, index));
      });

      // 正在流式的那一轮：形态跟落地后的消息一致，收完直接换掉，不会闪。
      if (busy) {
        const live = [];
        if (liveThink.trim().length > 0) {
          live.push(react.createElement(ThinkingBlock, { key: "lv-think", text: liveThink, live: true }));
        }
        liveItems.forEach((item, index) => {
          if (item.kind === "tool") {
            live.push(react.createElement(ToolCard, { key: `lv-t${index}`, step: item.step }));
          } else {
            live.push(react.createElement(MarkdownBody, { key: `lv-x${index}`, text: item.text, live: true }));
          }
        });
        if (live.length === 0) {
          live.push(react.createElement("div", { key: "lv-wait", style: S.hint }, "思考中…"));
        }
        nodes.push(
          react.createElement(
            "div",
            { key: "live", style: S.msgRow },
            react.createElement("div", { style: S.avatar }, "✦"),
            react.createElement("div", { style: S.msgCol }, ...live),
          ),
        );
      }

      // 非流式回退（宿主旧版）时，steps 还是独立 state，堆在末尾。
      steps.forEach((step, index) => {
        nodes.push(react.createElement(ToolCard, { key: `t${index}`, step }));
      });
      if (nodes.length === 0) {
        nodes.push(
          react.createElement(
            "div",
            { key: "hello", style: S.hint },
            "跟它说你想在远端做什么，它会自己用 SSH 去干活。比如：在 /home/admin/demo 下写一个 hello.py 并跑一遍。",
          ),
        );
      }

      // 下拉内容：用户配过的提供商各占一个 optgroup，网关剩下没配的再合成一个组。
      const modelOptions = [];
      for (const group of modelGroups) {
        modelOptions.push(
          react.createElement(
            "optgroup",
            { key: `g-${group.name}`, label: `${group.name} · ${group.models.length} 个模型` },
            ...group.models.map((item) =>
              react.createElement(
                "option",
                { key: item.id, style: optionStyle(), value: item.id, title: item.id },
                item.name.length > 0 ? item.name : item.id,
              ),
            ),
          ),
        );
      }
      if (modelExtra.length > 0) {
        modelOptions.push(
          react.createElement(
            "optgroup",
            { key: "g-extra", label: `网关其余模型 · ${modelExtra.length} 个` },
            ...modelExtra.map((id) =>
              react.createElement("option", { key: id, style: optionStyle(), value: id }, id),
            ),
          ),
        );
      }
      // 宿主没给分组（老版本宿主，或读不到 profile 配置）就平铺，行为与以前一致。
      if (modelOptions.length === 0) {
        for (const id of models) {
          modelOptions.push(
            react.createElement("option", { key: id, style: optionStyle(), value: id }, id),
          );
        }
      }

      const header = react.createElement(
        "div",
        { style: S.tabRow },
        docked
          ? null
          : react.createElement("button", { style: S.tab, onClick: onBack }, "📁 文件"),
        react.createElement("span", { style: S.tabActive }, "✦ AI 对话"),
        react.createElement("div", { style: S.grow }),
        react.createElement(
          "span",
          {
            style: {
              color: "rgba(178,196,220,0.92)",
              fontSize: 12,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 160,
            },
            title: connection
              ? connection.label || connection.name || connection.host
              : "未选连接",
          },
          connection ? connection.label || connection.name || connection.host : "未选连接",
        ),
        react.createElement(
          "select",
          {
            style: {
              ...selectStyle(),
              fontSize: 12,
              padding: "3px 6px",
              maxWidth: 220,
              flex: "0 0 auto",
            },
            title:
              (saveNote.length > 0 ? `模型：${chosen}\n${saveNote}` : "选择模型") +
              (modelGroups.length > 0 ? `\n可选提供商：${modelGroups.map((g) => g.name).join(" / ")}` : ""),
            value: chosen,
            disabled: models.length === 0,
            onChange: (event) => pickModel(event.target.value),
          },
          ...(models.length === 0
            ? [
                react.createElement(
                  "option",
                  { key: "__loading", style: optionStyle(), value: "" },
                  "模型加载中…",
                ),
              ]
            : modelOptions),
        ),
        model.length > 0 && model !== chosen
          ? react.createElement(
              "span",
              {
                style: { color: "rgba(127,127,127,1)", fontSize: 11, whiteSpace: "nowrap" },
                title: "上一轮实际使用的模型",
              },
              `实际：${model}`,
            )
          : null,
        messages.length > 0
          ? react.createElement(
              "button",
              {
                style: S.button,
                title: "清空对话",
                onClick: () => {
                  setMessages([]);
                  setSteps([]);
                  setError("");
                },
              },
              "清空",
            )
          : null,
        docked
          ? react.createElement(
              "button",
              { style: S.button, title: "关闭对话面板", onClick: onBack },
              "✕",
            )
          : null,
      );

      const foot = react.createElement(
        "div",
        { style: S.chatFoot },
        react.createElement("textarea", {
          style: textareaStyle(),
          value: input,
          placeholder: CHAT_PLACEHOLDER,
          onChange: (event) => setInput(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          },
        }),
        react.createElement(
          "div",
          { style: S.bar },
          react.createElement(
            "button",
            { style: S.button, disabled: busy || input.trim().length === 0, onClick: () => void send() },
            busy ? "思考中…" : "发送",
          ),
          react.createElement("div", { style: S.grow }),
          react.createElement(
            "span",
            { style: { color: "rgba(127,127,127,1)", fontSize: 11.5 } },
            "它会通过 SSH 直接操作远端主机",
          ),
        ),
        error ? react.createElement("div", { style: S.banner }, error) : null,
      );

      return react.createElement(
        "div",
        { style: S.chatRoot },
        header,
        react.createElement("div", { style: S.chatLog, ref: scroller }, nodes),
        foot,
      );
    }

    // ───────────────────────────────────────────────── 远端终端

    const TERM_HEIGHT_KEY = "dsh-ssh-explorer.termHeight";
    const TERM_HEIGHT_DEFAULT = 220;

    /** 终端每一行的配色。 */
    function termLineStyle(kind) {
      if (kind === "echo") return { ...S.termLine, ...S.termEcho };
      if (kind === "err") return { ...S.termLine, ...S.termErr };
      if (kind === "meta") return { ...S.termLine, ...S.termMeta };
      return { ...S.termLine, ...S.termOut };
    }

    /**
     * 水平分隔条。按住上下拖，改上下两个面板的高度。
     *
     * 方向同样按「直接操作」定：边界往上移，下方那个面板就变高。
     * - invert=false（受控面板在分隔条**上面**）：往下拖＝变高
     * - invert=true （受控面板在分隔条**下面**，如底部终端）：往上拖＝变高
     */
    function HSplit(props) {
      const value = props.value;
      const min = props.min;
      const max = props.max;
      const invert = props.invert === true;
      const onChange = props.onChange;

      const onMouseDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startY = event.clientY;
        const startValue = value;
        const move = (moveEvent) => {
          const delta = invert ? startY - moveEvent.clientY : moveEvent.clientY - startY;
          onChange(Math.min(max, Math.max(min, Math.round(startValue + delta))));
        };
        const setBodyCursor = (on) => {
          if (typeof document === "undefined" || !document.body || !document.body.style) return;
          document.body.style.userSelect = on ? "none" : "";
          document.body.style.cursor = on ? "row-resize" : "";
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          setBodyCursor(false);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        setBodyCursor(true);
      };

      return react.createElement("div", {
        style: S.splitH,
        onMouseDown,
        title: invert ? "按住上下拖动，调整高度（往上拖变高）" : "按住上下拖动，调整高度（往下拖变高）",
        role: "separator",
        "aria-orientation": "horizontal",
      });
    }

    /**
     * 远端终端。
     *
     * **不是 PTY**：每条命令单开一次 ssh，靠 EXIT trap 回传退出码与最终 cwd。
     * 所以 `cd` 会累积、退出码是真的；但 vim/top 这类全屏交互程序跑不了，
     * 每条命令里的环境变量与 shell 状态也不会保留到下一跳。
     */
    function TerminalPanel(props) {
      const connection = props.connection;
      const [lines, setLines] = react.useState([]);
      const [cwd, setCwd] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [cmd, setCmd] = react.useState("");
      const [history, setHistory] = react.useState([]);
      const [histIndex, setHistIndex] = react.useState(-1);
      const scroller = react.useRef(null);

      const push = react.useCallback((entries) => {
        if (entries.length === 0) return;
        setLines((prev) => prev.concat(entries).slice(-500));
      }, []);

      react.useEffect(() => {
        const node = scroller.current;
        if (node && typeof node.scrollTop === "number") node.scrollTop = node.scrollHeight;
      });

      const run = react.useCallback(
        async (raw) => {
          const text = String(raw ?? "");
          if (busy) return;
          if (!connection) {
            push([{ kind: "err", text: "先在「文件」页选一个连接" }]);
            return;
          }
          setCmd("");
          if (text.trim().length === 0) return;
          // `:` 是挂载时探初始 cwd 用的空命令，不回显。
          if (text.trim() !== ":") push([{ kind: "echo", text: `${cwd || "~"} $ ${text}` }]);
          setHistory((prev) => (prev[prev.length - 1] === text ? prev : prev.concat([text]).slice(-100)));
          setHistIndex(-1);
          setBusy(true);
          try {
            const res = await apiPost("exec", {
              connectionId: connection.id,
              command: text,
              cwd: cwd || undefined,
              timeoutMs: 120000,
            });
            if (!res || !res.ok) {
              push([{ kind: "err", text: String((res && res.error) || "执行失败") }]);
              return;
            }
            const add = [];
            const body = String(res.stdout ?? "");
            const err = String(res.stderr ?? "");
            if (body.length > 0) add.push({ kind: "out", text: body.replace(/\n$/, "") });
            if (err.length > 0) add.push({ kind: "err", text: err.replace(/\n$/, "") });
            if (typeof res.cwd === "string" && res.cwd.length > 0) setCwd(res.cwd);
            const code = Number(res.code);
            if (Number.isFinite(code) && code !== 0) add.push({ kind: "err", text: `（退出码 ${code}）` });
            push(add);
          } catch (err) {
            push([{ kind: "err", text: String(err && err.message ? err.message : err) }]);
          } finally {
            setBusy(false);
          }
        },
        [busy, connection, cwd, push],
      );

      // 挂载 / 换连接时打印一行问候，并探一次初始 cwd。
      const connId = connection ? connection.id : "";
      react.useEffect(() => {
        if (!connection) {
          push([{ kind: "meta", text: "未选连接：先在「文件」页选一个连接" }]);
          return;
        }
        push([
          {
            kind: "meta",
            text: `已连接 ${connection.label || connection.name || connection.host} · 每条命令单开一次 ssh，交互式程序（vim/top）不可用`,
          },
        ]);
        void run(":");
      }, [connId]);

      return react.createElement(
        "div",
        { style: S.termRoot },
        react.createElement(
          "div",
          { style: S.termHead },
          react.createElement("span", null, "⌨ 终端"),
          react.createElement(
            "span",
            {
              style: {
                color: "rgba(127,127,127,1)",
                fontSize: 11.5,
                fontFamily: "ui-monospace, Consolas, monospace",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 420,
              },
            },
            connection
              ? `${connection.label || connection.name || connection.host}${cwd ? `:${cwd}` : ""}`
              : "未选连接",
          ),
          react.createElement("div", { style: S.grow }),
          busy
            ? react.createElement(
                "span",
                { style: { color: "rgba(127,127,127,1)", fontSize: 11.5 } },
                "执行中…",
              )
            : null,
          react.createElement(
            "button",
            { type: "button", style: S.miniButton, onClick: () => setLines([]), title: "清屏" },
            "清屏",
          ),
          react.createElement(
            "button",
            { type: "button", style: S.miniButton, onClick: props.onClose, title: "关闭终端" },
            "✕",
          ),
        ),
        react.createElement(
          "div",
          { style: S.termLog, ref: scroller },
          ...lines.map((line, index) =>
            react.createElement("div", { key: index, style: termLineStyle(line.kind) }, line.text),
          ),
        ),
        react.createElement(
          "div",
          { style: S.termInputRow },
          react.createElement("span", { style: { color: "#7fd88f" } }, `${cwd || "~"} $`),
          react.createElement("input", {
            style: S.termInputBox,
            value: cmd,
            spellCheck: false,
            disabled: busy,
            placeholder: busy ? "执行中…" : "输入命令，Enter 执行（↑/↓ 翻历史）",
            onChange: (event) => setCmd(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void run(cmd);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                if (history.length === 0) return;
                const next = histIndex < 0 ? history.length - 1 : Math.max(0, histIndex - 1);
                setHistIndex(next);
                setCmd(history[next]);
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (history.length === 0 || histIndex < 0) return;
                const next = histIndex + 1;
                if (next >= history.length) {
                  setHistIndex(-1);
                  setCmd("");
                } else {
                  setHistIndex(next);
                  setCmd(history[next]);
                }
              }
            },
          }),
        ),
      );
    }

    function ExplorerPanel() {
      const [state, setState] = react.useState({
        loading: true,
        error: null,
        connections: [],
        /** 删掉的连接（只记名单；ssh config 里的主机靠它从清单里消失）。 */
        hidden: [],
        sshAvailable: true,
        chatEnabled: true,
        connectionId: "",
        path: "",
        parent: null,
        entries: [],
        listing: false,
      });
      const [preview, setPreview] = react.useState(null);
      const [showForm, setShowForm] = react.useState(false);
      const [info, setInfo] = react.useState(null);
      // 注意：这两个 useState 必须排在 info 之后，改动顺序会让测试替身的 hook 槽位整体错位。
      const [editing, setEditing] = react.useState(null);
      const [secretFor, setSecretFor] = react.useState(null);
      // 连不上且这条连接还没存口令时，就地提示输一次；之后自动记住。
      const [authInput, setAuthInput] = react.useState("");
      const [authBusy, setAuthBusy] = react.useState(false);
      // 「文件」还是「AI 对话」。同样必须排在前面的 state 之后，否则测试替身的 hook 槽位错位。
      const [view, setView] = react.useState("files");
      // 可拉伸面板的宽度（px）。默认值只在 localStorage 里没记录时才生效。
      const [listWidth, setListWidth] = react.useState(() =>
        readStoredWidth(LIST_WIDTH_KEY, LIST_WIDTH_DEFAULT, 200, 4000),
      );
      const [chatWidth, setChatWidth] = react.useState(() =>
        readStoredWidth(CHAT_WIDTH_KEY, CHAT_WIDTH_DEFAULT, 280, 2000),
      );
      // 底部终端：开关 + 高度（高度也记在 localStorage 里）。
      const [termOpen, setTermOpen] = react.useState(false);
      const [termHeight, setTermHeight] = react.useState(() =>
        readStoredWidth(TERM_HEIGHT_KEY, TERM_HEIGHT_DEFAULT, 120, 900),
      );

      react.useEffect(() => {
        writeStoredWidth(TERM_HEIGHT_KEY, termHeight);
      }, [termHeight]);

      react.useEffect(() => {
        writeStoredWidth(LIST_WIDTH_KEY, listWidth);
      }, [listWidth]);

      react.useEffect(() => {
        writeStoredWidth(CHAT_WIDTH_KEY, chatWidth);
      }, [chatWidth]);

      const patch = (part) => setState((previous) => ({ ...previous, ...part }));

      /** 载入连接清单。 */
      const loadConnections = react.useCallback(async (preferId) => {
        try {
          const answer = await api("connections");
          const connections = answer.connections ?? [];
          const wanted = preferId ?? state.connectionId;
          const picked =
            connections.find((item) => item.id === wanted) ??
            connections[0] ??
            null;
          setState((previous) => ({
            ...previous,
            loading: false,
            error: answer.ok === false ? answer.error : null,
            connections,
            hidden: Array.isArray(answer.hidden) ? answer.hidden : [],
            sshAvailable: answer.sshAvailable !== false,
            chatEnabled: answer.chatEnabled !== false,
            connectionId: picked ? picked.id : "",
          }));
          return picked;
        } catch (error) {
          patch({ loading: false, error: String(error && error.message ? error.message : error) });
          return null;
        }
      }, [state.connectionId]);

      /** 列一个目录。 */
      const browse = react.useCallback(async (connectionId, path) => {
        if (!connectionId) return;
        setState((previous) => ({ ...previous, listing: true, error: null }));
        try {
          const answer = await api("list", { connection: connectionId, path });
          if (answer.ok) {
            patch({
              listing: false,
              path: answer.path ?? path ?? "",
              parent: answer.parent ?? null,
              entries: answer.entries ?? [],
              error: null,
            });
          } else {
            patch({ listing: false, entries: [], error: answer.error || "列目录失败" });
          }
        } catch (error) {
          patch({ listing: false, error: String(error && error.message ? error.message : error) });
        }
      }, []);

      /** 首次挂载：列连接 + 读主机概况。 */
      react.useEffect(() => {
        let alive = true;
        void (async () => {
          const picked = await loadConnections();
          if (!alive || !picked) return;
          void api("info", { connection: picked.id })
            .then((answer) => {
              if (alive && answer && answer.ok) setInfo(answer);
            })
            .catch(() => undefined);
        })();
        return () => {
          alive = false;
        };
        // 只在挂载时跑一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      /** 切换连接时回到该主机家目录。 */
      react.useEffect(() => {
        if (!state.connectionId) return;
        void browse(state.connectionId, "");
        void api("info", { connection: state.connectionId })
          .then((answer) => {
            if (answer && answer.ok) setInfo(answer);
          })
          .catch(() => undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state.connectionId]);

      /**
       * 远端文件的编辑草稿。`null` 表示不在编辑态。
       *
       * 这必须是 ExplorerPanel 的**第 14 个 hook（槽位 13）**——追加在最后，
       * 因为测试替身按调用顺序分配槽位，插在中间会让后面全错位。
       */
      const [draft, setDraft] = react.useState(null);

      // ── 拖拽传输
      //
      // 同样只能追加在这里之后：上面每一个 hook 的槽位都被测试替身按序号钉死了。

      /** 下载落点：`desktop` / `downloads` / 绝对路径。 */
      const [dest, setDest] = react.useState(() => readStoredText(DROP_DEST_KEY, "desktop"));
      /** 宿主报上来的本机落点真实路径（桌面可能被重定向到 D 盘或 OneDrive）。 */
      const [localDirs, setLocalDirs] = react.useState(null);
      /** 传输任务（宿主侧任务快照 + 客户端自己攒的字节流上传伪任务）。 */
      const [jobs, setJobs] = react.useState([]);
      /** 传输抽屉是否展开。 */
      const [drawerOpen, setDrawerOpen] = react.useState(() => readStoredText(DRAWER_KEY, "1") === "1");
      /** 正被拖入高亮的远端目录（null = 没在拖）。 */
      const [dropTarget, setDropTarget] = react.useState(null);
      /** 本次拖出的远端路径，以及「有没有拖出过窗口」。 */
      const dragRef = react.useRef(null);

      /** 读一次本机落点真实路径（桌面/下载）。 */
      react.useEffect(() => {
        let alive = true;
        void api("locals")
          .then((answer) => {
            if (alive && answer && answer.ok) setLocalDirs(answer);
          })
          .catch(() => undefined);
        return () => {
          alive = false;
        };
      }, []);

      react.useEffect(() => {
        writeStoredText(DROP_DEST_KEY, dest);
      }, [dest]);

      react.useEffect(() => {
        writeStoredText(DRAWER_KEY, drawerOpen ? "1" : "0");
      }, [drawerOpen]);

      /**
       * 浏览器不可能把「真文件」交给桌面，我们能做的只有：发现用户把某一行拖出了窗口，
       * 就当作「要它的一个副本」，替他在后台传一份到落点。
       *
       * `relatedTarget === null` 是「指针离开了窗口」的通用判定（拖进/拖出都靠它）。
       */
      react.useEffect(() => {
        if (typeof document === "undefined") return undefined;
        const onLeave = (event) => {
          if (dragRef.current !== null && event.relatedTarget === null) dragRef.current.left = true;
        };
        const onEnter = () => {
          if (dragRef.current !== null) dragRef.current.left = false;
        };
        document.addEventListener("dragleave", onLeave);
        document.addEventListener("dragenter", onEnter);
        return () => {
          document.removeEventListener("dragleave", onLeave);
          document.removeEventListener("dragenter", onEnter);
        };
      }, []);

      /** 正在跑的宿主任务 id 串。只依赖它，进度变化不会把定时器重建一遍。 */
      const runningIds = jobs
        .filter((job) => job.state === "running" && job.local !== true)
        .map((job) => job.id)
        .join(",");

      react.useEffect(() => {
        if (runningIds.length === 0) return undefined;
        let alive = true;
        const tick = async () => {
          const ids = runningIds.split(",");
          const answers = await Promise.all(
            ids.map((id) => apiGet(`job?id=${encodeURIComponent(id)}`).catch(() => null)),
          );
          if (!alive) return;
          const updated = answers.map((answer) => (answer && answer.job ? answer.job : null)).filter((job) => job !== null);
          if (updated.length === 0) return;
          setJobs((previous) => previous.map((job) => updated.find((next) => next.id === job.id) ?? job));
          // 刚跑完的话，远端目录内容变了，顺手刷新一下列表。
          if (updated.some((job) => job.state !== "running")) void browse(state.connectionId, state.path);
        };
        const timer = setInterval(() => void tick(), 700);
        void tick();
        return () => {
          alive = false;
          clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [runningIds]);

      // 连接管理（删除设备）。这两个 hook 必须排在上面那个轮询 effect 之后，
      // 否则测试替身的 hook 槽位会整体错位（见文件顶部槽位说明）。
      /** 连接管理浮层是否展开。 */
      const [manageOpen, setManageOpen] = react.useState(false);
      /** 正在等二次确认的那条连接 id（null = 没有待确认的）。 */
      const [pendingDelete, setPendingDelete] = react.useState(null);

      // ── 选中 / 右键菜单 / 待确认删除
      //
      // 同样只能追加在最后：上面每个 hook 的槽位都被测试替身按序号钉死了。
      /** 选中的远端全路径（单击选中、按住 Ctrl/⌘ 再点增删）。 */
      const [selected, setSelected] = react.useState([]);
      /** 右键菜单：{ x, y, paths }（null = 没开）。 */
      const [rowMenu, setRowMenu] = react.useState(null);
      /** 等用户确认删除的远端路径（null = 没在确认）。 */
      const [confirmDelete, setConfirmDelete] = react.useState(null);
      /**
       * 「输入名字」浮层：新建文件 / 新建文件夹 / 重命名共用一个。
       * 形状 `{mode:"rename"|"newfile"|"newdir", target, dir, value, error, busy}`。
       */
      const [namePrompt, setNamePrompt] = react.useState(null);

      /** Del 键删除选中项（输入框/文本域里按 Del 不拦，那是删字）。 */
      react.useEffect(() => {
        if (typeof document === "undefined" || typeof document.addEventListener !== "function") return undefined;
        const onKeyDown = (event) => {
          if (event.key !== "Delete") return;
          const node = event.target;
          const tag = node && typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
          if (node && node.isContentEditable === true) return;
          if (selected.length === 0) return;
          event.preventDefault();
          setConfirmDelete(selected.slice());
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [selected]);

      /** 换目录 / 换主机就把选中清掉，免得对着上一处的路径下手。 */
      react.useEffect(() => {
        setSelected([]);
        setRowMenu(null);
        setConfirmDelete(null);
        setNamePrompt(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state.path, state.connectionId]);

      /** 落点的中文名（下拉框和行内提示都用它）。 */
      const destLabel =
        dest === "desktop" ? "桌面" : dest === "downloads" ? "下载" : baseName(dest) || dest;

      /** 把宿主返回的任务塞进抽屉（同 id 覆盖），并展开抽屉让用户看见。 */
      const addJob = (job) => {
        if (job === null || job === undefined) return;
        setDrawerOpen(true);
        setJobs((previous) => [job, ...previous.filter((item) => item.id !== job.id)].slice(0, 8));
      };

      /** 取消一个宿主任务。 */
      const cancelJob = async (id) => {
        try {
          const answer = await apiPost("job", { id, cancel: true });
          if (answer.ok && answer.job) addJob(answer.job);
        } catch {
          /* 任务已经结束就无所谓 */
        }
      };

      /** 在资源管理器里选中刚落地的文件/文件夹。 */
      const revealPath = async (path) => {
        try {
          await apiPost("reveal", { path });
        } catch {
          /* 定位失败不影响传输结果 */
        }
      };

      /** 下载：把远端路径（文件或目录）落到本机的落点目录（默认桌面）。 */
      const startPull = async (paths) => {
        if (!state.connectionId || paths.length === 0) return;
        try {
          const answer = await apiPost("pull", {
            connection: state.connectionId,
            paths,
            target: dest,
          });
          if (answer.ok !== true) {
            patch({ error: answer.error || "下载失败" });
            return;
          }
          addJob(answer.job);
          patch({ error: null });
        } catch (error) {
          patch({ error: String(error && error.message ? error.message : error) });
        }
      };

      /** 上传：把本机绝对路径交给宿主直读（快，目录一次 tar 就搬完）。 */
      const pushPaths = async (paths, dir) => {
        try {
          const answer = await apiPost("push", {
            connection: state.connectionId,
            dir,
            paths,
          });
          if (answer.ok !== true) {
            patch({ error: answer.error || "上传失败" });
            return;
          }
          addJob(answer.job);
          patch({ error: null });
        } catch (error) {
          patch({ error: String(error && error.message ? error.message : error) });
        }
      };

      /** 字节流兜底：逐个文件推到 dir/relPath，自攒一个伪任务显示进度。 */
      const uploadDropped = async (pairs, dir) => {
        if (pairs.length === 0) return;
        const localId = `local-${Date.now().toString(36)}`;
        const total = pairs.reduce((sum, pair) => sum + (pair.file.size || 0), 0);
        addJob({
          id: localId,
          kind: "upload",
          title: pairs.length === 1 ? pairs[0].relPath : `${pairs.length} 个文件`,
          state: "running",
          phase: "上传中",
          items: [],
          bytes: 0,
          total,
          message: "",
          target: dir,
          openPath: "",
          local: true,
        });
        const bump = (update) =>
          setJobs((previous) => previous.map((item) => (item.id === localId ? { ...item, ...update } : item)));
        let sent = 0;
        let failed = 0;
        for (const pair of pairs) {
          bump({ phase: `上传 ${pair.relPath}` });
          const answer = await uploadBytes(state.connectionId, dir, pair.relPath, pair.file, (loaded) =>
            bump({ bytes: sent + loaded }),
          );
          sent += pair.file.size || 0;
          if (answer.ok !== true) failed += 1;
          bump({ bytes: sent });
        }
        bump({
          state: failed === 0 ? "done" : "failed",
          phase: failed === 0 ? "完成" : `${failed} 个没传上去`,
          bytes: sent,
          message: failed === 0 ? "" : "常见原因是远端目录没有写权限",
        });
        void browse(state.connectionId, dir);
      };

      /** 处理一次拖入：优先本机路径直读，拿不到路径就退回字节流。 */
      const acceptDrop = async (dataTransfer, dir) => {
        if (!state.connectionId) {
          patch({ error: "先选一台主机，再把文件拖进来" });
          return;
        }
        const paths = hostPathsOf(dataTransfer);
        if (paths !== null && paths.length > 0) {
          await pushPaths(paths, dir);
          return;
        }
        const pairs = await collectDropped(dataTransfer);
        if (pairs.length === 0) {
          patch({ error: "没从拖进来的内容里读到文件" });
          return;
        }
        await uploadDropped(pairs, dir);
      };

      /** 这一条在不在选中集合里。 */
      const isSelected = (path) => selected.includes(path);

      /**
       * 单击一行：选中它；按住 Ctrl/⌘ 再点就是「加上/去掉这一条」。
       *
       * 单击不再直接进目录 —— 进目录是双击的事。单选得留给「拖出去传文件」，
       * 否则手一抖目录就翻页了，多选也做不成。
       */
      const onRowClick = (event, entry, full) => {
        setRowMenu(null);
        const multi = event.ctrlKey === true || event.metaKey === true;
        if (multi) {
          setSelected((previous) =>
            previous.includes(full) ? previous.filter((item) => item !== full) : [...previous, full],
          );
          return;
        }
        setSelected([full]);
        // 文件点一下顺手预览；目录不动，等双击。
        if (entry.dir !== true) void openFile(entry);
      };

      /** 双击：目录进下一层，文件重新拉一次预览。 */
      const onRowDoubleClick = (entry, full) => {
        if (entry.dir === true) {
          setSelected([]);
          void browse(state.connectionId, full);
          return;
        }
        void openFile(entry);
      };

      /** 右键：点在没选中的行上先把选中换成这一行（跟资源管理器一致）。 */
      const onRowContextMenu = (event, entry, full) => {
        if (typeof event.preventDefault === "function") event.preventDefault();
        // 别冒泡到列表容器：那边是「空白处右键 = 新建」的入口。
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        const paths = selected.includes(full) ? selected.slice() : [full];
        if (!selected.includes(full)) setSelected([full]);
        setRowMenu({ x: Number(event.clientX) || 0, y: Number(event.clientY) || 0, paths });
      };

      /** 空白处右键：菜单里是「新建文件 / 新建文件夹」，作用在 dir 上。 */
      const onBlankContextMenu = (event, dir) => {
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        setSelected([]);
        setRowMenu({
          x: Number(event.clientX) || 0,
          y: Number(event.clientY) || 0,
          paths: [],
          dir: dir || state.path,
        });
      };

      /** 打开「输入名字」浮层。rename 要一条路径，新建要一个目录。 */
      const openPrompt = (mode, options) => {
        const extra = options || {};
        if (mode === "rename") {
          const target = String(extra.target || "");
          if (target.length === 0) return;
          setNamePrompt({
            mode,
            target,
            dir: parentOf(target),
            value: baseName(target),
            error: null,
            busy: false,
          });
          return;
        }
        setNamePrompt({
          mode,
          target: "",
          dir: String(extra.dir || state.path),
          value: "",
          error: null,
          busy: false,
        });
      };

      /** 提交「输入名字」浮层：改名走 /rename，新建走 /create，成功后刷新列表并把新条目选中。 */
      const submitPrompt = async () => {
        const prompt = namePrompt;
        if (prompt === null || prompt.busy === true) return;
        const name = String(prompt.value ?? "").trim();
        const complain = (message) => setNamePrompt({ ...prompt, busy: false, error: message });
        if (name.length === 0) {
          complain("名字不能为空");
          return;
        }
        if (name.includes("/") || name.includes("\\")) {
          complain("名字里不能带路径分隔符");
          return;
        }
        setNamePrompt({ ...prompt, busy: true, error: null });
        try {
          if (prompt.mode === "rename") {
            const answer = await apiPost("rename", { connection: state.connectionId, path: prompt.target, name });
            if (answer.ok !== true) throw new Error(answer.error || "重命名失败");
            const nextPath = String(answer.path || joinPath(prompt.dir, name));
            // 正在预览的就是被改名的那份，路径已经失效，先清掉。
            if (preview !== null && preview.path === prompt.target) setPreview(null);
            setSelected([nextPath]);
          } else {
            const kind = prompt.mode === "newdir" ? "dir" : "file";
            const answer = await apiPost("create", { connection: state.connectionId, dir: prompt.dir, name, kind });
            if (answer.ok !== true) throw new Error(answer.error || "新建失败");
            setSelected([String(answer.path || joinPath(prompt.dir, name))]);
          }
          setNamePrompt(null);
          patch({ error: null });
          void browse(state.connectionId, state.path);
        } catch (error) {
          complain(String(error && error.message ? error.message : error));
        }
      };

      /** 真正执行远端删除（确认之后）。逐条删，失败的第一条报出来。 */
      const performDelete = async (paths) => {
        setConfirmDelete(null);
        setRowMenu(null);
        try {
          const answer = await apiPost("delete", { connection: state.connectionId, paths });
          const failed = Array.isArray(answer.failed) ? answer.failed : [];
          if (failed.length > 0) {
            const first = failed[0];
            patch({ error: `没删掉 ${baseName(first.path)}：${first.error || "远端拒绝了"}` });
          } else {
            patch({ error: answer.ok === true ? null : answer.error || "删除失败" });
          }
          setSelected([]);
          void browse(state.connectionId, state.path);
        } catch (error) {
          patch({ error: String(error && error.message ? error.message : error) });
        }
      };

      /** 拖出开始：拖的是选中集合里的某一条就整批拖，否则只拖这一条。 */
      const onRowDragStart = (event, remotePath, isDir) => {
        const dataTransfer = event.dataTransfer;
        const paths = selected.includes(remotePath) ? selected.slice() : [remotePath];
        dragRef.current = { paths, left: false };
        if (dataTransfer === null || dataTransfer === undefined) return;
        try {
          dataTransfer.effectAllowed = "copy";
          dataTransfer.setData("text/plain", paths.join("\n"));
        } catch {
          /* 不给写就算了 */
        }
        // 顺手清掉拖入高亮，免得两者叠在一起。
        if (isDir) setDropTarget(null);
      };

      /** 拖出结束：如果指针曾经离开窗口，就当作「放到了桌面」，替他去传。 */
      const onRowDragEnd = () => {
        const pending = dragRef.current;
        dragRef.current = null;
        if (pending === null) return;
        if (pending.left === true) void startPull(pending.paths);
      };

      /** 拖入落在列表上（目标是当前目录）。 */
      const onAreaDragOver = (event, dir) => {
        if (!hasFilePayload(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          event.dataTransfer.dropEffect = "copy";
        } catch {
          /* 只读的 dataTransfer */
        }
        if (dropTarget !== dir) setDropTarget(dir);
      };

      const onAreaDragLeave = (event) => {
        if (!hasFilePayload(event.dataTransfer)) return;
        const next = event.relatedTarget;
        if (next !== null && next !== undefined && event.currentTarget.contains(next)) return;
        setDropTarget(null);
      };

      const onAreaDrop = (event, dir) => {
        if (!hasFilePayload(event.dataTransfer)) return;
        // 必须两样都拦：DSH 外壳会把拖进来的文件变成「@路径」塞进输入框。
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(null);
        void acceptDrop(event.dataTransfer, dir);
      };

      /** 进入编辑态：拿当前预览的文本当草稿。 */
      const startEdit = () => {
        if (preview === null || preview.ok !== true || preview.binary) return;
        setDraft({
          path: preview.path,
          text: String(preview.text ?? ""),
          original: String(preview.text ?? ""),
          busy: false,
          error: "",
          note: "",
        });
      };

      /** 保存草稿（Ctrl+S 与「保存」按钮共用）。 */
      const saveEdit = async (current) => {
        const target = current ?? draft;
        if (target === null || target.busy) return;
        setDraft({ ...target, busy: true, error: "", note: "" });
        try {
          const answer = await apiPost("write", {
            connection: state.connectionId,
            path: target.path,
            content: target.text,
          });
          if (answer.ok === false) {
            setDraft({ ...target, busy: false, error: answer.error || "保存失败" });
            return;
          }
          const note = answer.existed
            ? `已保存 ${answer.bytes} 字节 · 原文件备份为 ${answer.backup}`
            : `已保存 ${answer.bytes} 字节 · 新建文件`;
          setDraft({ ...target, busy: false, error: "", note, original: target.text });
          setPreview((previous) =>
            previous === null ? previous : { ...previous, text: target.text, size: answer.bytes, truncated: false },
          );
          // 大小与修改时间都变了，顺手刷新列表。
          void browse(state.connectionId, state.path);
        } catch (error) {
          setDraft({ ...target, busy: false, error: String(error && error.message ? error.message : error) });
        }
      };

      /** 编辑框的键盘处理：Ctrl/Cmd+S 保存，Esc 退出。 */
      const onDraftKeyDown = (event) => {
        if (event.key === "s" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void saveEdit();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(null);
        }
      };

      /** 打开一个文件预览。 */
      const openFile = async (entry) => {
        setDraft(null);
        setPreview({ loading: true, path: joinPath(state.path, entry.name) });
        try {
          const answer = await api("read", { connection: state.connectionId, path: joinPath(state.path, entry.name) });
          setPreview({ ...answer, loading: false, name: entry.name });
        } catch (error) {
          setPreview({ ok: false, loading: false, error: String(error && error.message ? error.message : error) });
        }
      };

      /**
       * 删除一台连接（不再需要的设备）。
       *
       * 自建的从 connections.json 里真删；从 ~/.ssh/config 发现的主机只从清单里隐藏
       * —— 那份配置是用户手写的，插件不擅自改写。删掉的都会进「已删除」名单，可以恢复。
       */
      const removeConnection = async (connection) => {
        setPendingDelete(null);
        try {
          const answer = await apiPost("connections", { action: "delete", id: connection.id });
          if (!answer.ok) {
            patch({ error: answer.error || "删除失败" });
            return;
          }
          const wasCurrent = state.connectionId === connection.id;
          if (wasCurrent) {
            setPreview(null);
            setInfo(null);
            patch({ entries: [], path: "", parent: null });
          }
          const picked = await loadConnections(wasCurrent ? "" : state.connectionId);
          if (wasCurrent && picked) void browse(picked.id, "");
        } catch (error) {
          patch({ error: String(error && error.message ? error.message : error) });
        }
      };

      /** 把删掉的连接放回清单。 */
      const restoreConnection = async (entry) => {
        try {
          const answer = await apiPost("connections", { action: "restore", id: entry.id });
          if (!answer.ok) {
            patch({ error: answer.error || "恢复失败" });
            return;
          }
          await loadConnections(state.connectionId);
        } catch (error) {
          patch({ error: String(error && error.message ? error.message : error) });
        }
      };

      // ── 渲染

      // 这条连接是不是「认证失败、而且还没存口令」——是的话就地给个输入框。
      const currentConnection = state.connections.find((item) => item.id === state.connectionId) ?? null;
      const authFailed =
        typeof state.error === "string" &&
        /permission denied|publickey|authentication|password/i.test(state.error);
      const needsPassword =
        authFailed && currentConnection !== null && currentConnection.hasPassword !== true;

      const saveAuth = async () => {
        const password = authInput;
        const id = state.connectionId;
        if (password.length === 0 || id.length === 0) return;
        setAuthBusy(true);
        try {
          const answer = await apiPost("connections", { action: "secret", id, password });
          if (!answer.ok) {
            patch({ error: answer.error || "口令保存失败" });
            return;
          }
          setAuthInput("");
          const picked = await loadConnections(id);
          if (picked) void browse(id, state.path || "");
        } finally {
          setAuthBusy(false);
        }
      };

      const children = [];

      if (state.error) {
        children.push(react.createElement("div", { key: "err", style: S.banner }, state.error));
      }

      if (needsPassword) {
        children.push(
          react.createElement(
            "div",
            { key: "auth", style: S.banner },
            react.createElement("div", null, "这台主机要口令。输一次就加密保存，以后自动用。"),
            react.createElement("input", {
              type: "password",
              style: inputStyle(),
              value: authInput,
              placeholder: "登录密码或密钥口令",
              onChange: (event) => setAuthInput(event.target.value),
            }),
            react.createElement(
              "button",
              {
                style: S.button,
                disabled: authBusy,
                onClick: () => void saveAuth(),
              },
              authBusy ? "保存中…" : "保存口令并重试",
            ),
          ),
        );
      }

      // 顶部工具条
      children.push(
        react.createElement(
          "div",
          { key: "bar", style: S.bar },
          react.createElement(
            "select",
            {
              style: selectStyle(),
              value: state.connectionId,
              onChange: (event) => patch({ connectionId: event.target.value, entries: [], path: "" }),
            },
            state.connections.length === 0
              ? react.createElement("option", { value: "", style: optionStyle() }, "（没有可用连接）")
              : null,
            state.connections.map((item) =>
              react.createElement(
                "option",
                { key: item.id, value: item.id, style: optionStyle() },
                `${item.name}${item.user ? ` · ${item.user}@${item.host}` : ` · ${item.host}`}`,
              ),
            ),
          ),
          react.createElement(
            "button",
            {
              style: S.button,
              onClick: () => {
                if (showForm) {
                  setShowForm(false);
                  setEditing(null);
                  return;
                }
                setEditing(null);
                setShowForm(true);
              },
              title: "新增一个 SSH 连接",
            },
            showForm ? "收起" : "＋ 新建连接",
          ),
          react.createElement(
            "button",
            {
              style: S.button,
              onClick: () => {
                setPendingDelete(null);
                setManageOpen((open) => !open);
              },
              title: "管理连接：删除不再需要的设备（也能把删掉的放回来）",
            },
            manageOpen ? "收起管理" : "🗑 管理连接",
          ),
          state.connectionId
            ? react.createElement(
                "button",
                {
                  style: S.button,
                  onClick: () => void browse(state.connectionId, ""),
                  title: "回到远端家目录",
                },
                "⌂ 家目录",
              )
            : null,
          state.parent
            ? react.createElement(
                "button",
                { style: S.button, onClick: () => void browse(state.connectionId, state.parent), title: "上一层" },
                "↑ 上级",
              )
            : null,
          react.createElement(
            "button",
            {
              style: S.button,
              onClick: () => void browse(state.connectionId, state.path),
              title: "刷新当前目录",
            },
            "⟳ 刷新",
          ),
          state.chatEnabled === false
            ? null
            : react.createElement(
                "button",
                {
                  style: S.button,
                  onClick: () => setView(view === "chat" ? "files" : "chat"),
                  title: "在右侧打开/收起 AI 对话面板（面板左边可拖动调宽度）",
                },
                view === "chat" ? "✦ 收起对话" : "✦ AI 对话",
              ),
          react.createElement(
            "button",
            {
              style: S.button,
              onClick: () => setTermOpen(!termOpen),
              title: "在底部打开/收起远端终端（分隔条可上下拖动调高度）",
            },
            termOpen ? "⌨ 收起终端" : "⌨ 终端",
          ),
          jobs.length > 0
            ? react.createElement(
                "button",
                {
                  style: S.button,
                  onClick: () => setDrawerOpen(!drawerOpen),
                  title: "打开/收起右下角的传输面板",
                },
                `⇅ 传输${jobs.filter((job) => job.state === "running").length > 0 ? ` · ${jobs.filter((job) => job.state === "running").length}` : ""}`,
              )
            : null,
          react.createElement("div", { style: S.grow }),
          info && info.ok
            ? react.createElement(
                "span",
                { style: { color: "rgba(127,127,127,1)", fontSize: 12 } },
                `${info.hostname} · ${info.os}`,
              )
            : null,
        ),
      );

      // 新建 / 编辑连接表单
      if (showForm) {
        children.push(
          react.createElement(ConnectionForm, {
            key: editing ? `form-${editing.id}` : "form",
            initial: editing,
            onCancel: () => {
              setShowForm(false);
              setEditing(null);
            },
            onSaved: (connection) => {
              setShowForm(false);
              setEditing(null);
              void (async () => {
                await loadConnections(connection.id);
                void browse(connection.id, "");
              })();
            },
            onError: (message) => patch({ error: message }),
          }),
        );
      }

      // 口令设置弹层
      if (secretFor) {
        children.push(
          react.createElement(SecretDialog, {
            key: `secret-${secretFor.id}`,
            connection: secretFor,
            onCancel: () => setSecretFor(null),
            onDone: () => {
              const id = secretFor.id;
              setSecretFor(null);
              patch({ error: null });
              void loadConnections(id);
            },
            onError: (message) => patch({ error: message }),
          }),
        );
      }

      // 面包屑
      if (state.connectionId && state.path) {
        const crumbs = crumbsOf(state.path);
        children.push(
          react.createElement(
            "div",
            {
              key: "crumbs",
              style: {
                display: "flex",
                alignItems: "center",
                gap: 2,
                padding: "6px 12px",
                borderBottom: "1px solid rgba(127,127,127,0.25)",
                flexWrap: "wrap",
                fontSize: 12,
              },
            },
            crumbs.map((crumb, index) =>
              react.createElement(
                react.Fragment,
                { key: crumb.path },
                index > 0 ? react.createElement("span", { style: { color: "rgba(127,127,127,1)" } }, "/") : null,
                react.createElement(
                  "span",
                  { style: S.crumb, onClick: () => void browse(state.connectionId, crumb.path) },
                  crumb.label,
                ),
              ),
            ),
          ),
        );
      }

      // 主体
      if (state.loading) {
        children.push(react.createElement("div", { key: "loading", style: S.hint }, "载入中…"));
      } else if (state.connections.length === 0) {
        children.push(
          react.createElement(
            "div",
            { key: "empty", style: S.hint },
            state.sshAvailable
              ? "还没有连接。点「＋ 新建连接」填主机、用户名和私钥，或先在 ~/.ssh/config 里写好 Host 别名。"
              : "找不到 ssh 可执行文件，请确认 Windows 的 OpenSSH 客户端可用。",
          ),
        );
      } else {
        const listRows = [];

        listRows.push(
          react.createElement(
            "div",
            { key: "head", style: S.head },
            state.listing
              ? "读取中…"
              : `${state.entries.length} 项${state.path ? ` · ${state.path}` : ""}`,
          ),
        );

        const current = state.connections.find((item) => item.id === state.connectionId);
        if (current) {
          listRows.push(
            react.createElement(
              "div",
              { key: "ops", style: { ...S.bar, borderBottom: "1px solid rgba(127,127,127,0.15)", flexWrap: "wrap" } },
              react.createElement(
                "span",
                { style: { fontSize: 12, color: "rgba(127,127,127,1)" } },
                `认证：${authLabel(current.authType)}${current.hasPassword ? " · 已存密码" : ""}`,
              ),
              react.createElement("div", { style: S.grow }),
              // 选中提示不放在这里 —— 它原来插在这行里，一旦选中就把这行挤成两行、
              // 下面 29 个文件全部下移一格。现在改成浮在列表底部的浮条（见 body 里
              // 的 selectionBar），不参与布局，选中前后一个像素都不动。
              react.createElement(
                "button",
                {
                  style: S.button,
                  onClick: () => setSecretFor(current),
                  title: "给这台主机单独设一个密码（不影响其它连接）",
                },
                current.hasPassword ? "🔑 改密码" : "🔑 设密码",
              ),
              current.readOnly
                ? react.createElement(
                    "span",
                    { style: { fontSize: 12, color: "rgba(127,127,127,1)" } },
                    "来自 ~/.ssh/config",
                  )
                : react.createElement(
                    "button",
                    {
                      style: S.button,
                      onClick: () => {
                        setEditing(current);
                        setShowForm(true);
                      },
                      title: "修改这个自建连接",
                    },
                    "编辑",
                  ),
              // 两种连接都能删：自建的真删，ssh config 里的只从清单隐藏。点一次变确认，防手滑。
              react.createElement(
                "button",
                {
                  style: S.dangerButton,
                  onClick: () => {
                    if (pendingDelete === current.id) void removeConnection(current);
                    else setPendingDelete(current.id);
                  },
                  title:
                    pendingDelete === current.id
                      ? "再点一次确认删除"
                      : current.readOnly
                        ? "从清单里隐藏这台（不改 ~/.ssh/config）"
                        : "删除这个自建连接",
                },
                pendingDelete === current.id ? "确认删除" : "删除",
              ),
              pendingDelete === current.id
                ? react.createElement(
                    "button",
                    { style: S.button, onClick: () => setPendingDelete(null), title: "不删了" },
                    "取消",
                  )
                : null,
            ),
          );
        }

        for (const entry of state.entries) {
          const isDir = entry.dir;
          const full = joinPath(state.path, entry.name);
          listRows.push(
            react.createElement(
              Row,
              {
                key: entry.name,
                title: isDir
                  ? `${full}\n单击选中 · Ctrl+单击加选 · 双击进入\n拖出去 = 下载到${destLabel}；把本机文件拖到这一行 = 传进这个目录\n右键可重命名 / 删除`
                  : `${full}\n单击选中 · Ctrl+单击加选 · 双击打开\n拖出去 = 下载到${destLabel}\n右键可重命名 / 删除`,
                // 每一行都能拖出去（文件直接落一个文件，目录落一整个目录）。
                draggable: true,
                onDragStart: (event) => onRowDragStart(event, full, isDir),
                onDragEnd: onRowDragEnd,
                // 目录行同时是拖入落点。
                dropping: isDir && dropTarget === full,
                onDragOver: isDir ? (event) => onAreaDragOver(event, full) : undefined,
                onDragLeave: isDir ? onAreaDragLeave : undefined,
                onDrop: isDir ? (event) => onAreaDrop(event, full) : undefined,
                // 单击 = 选中（Ctrl 多选），双击 = 进目录/开文件，右键 = 菜单。
                selected: isSelected(full),
                onClick: (event) => onRowClick(event, entry, full),
                onDoubleClick: () => onRowDoubleClick(entry, full),
                onContextMenu: (event) => onRowContextMenu(event, entry, full),
              },
              react.createElement(
                "span",
                { style: { flex: "0 0 18px", textAlign: "center", opacity: isDir ? 0.95 : 0.55 } },
                isDir ? "▸" : entry.link ? "↗" : "·",
              ),
              react.createElement("span", { style: S.cellName }, entry.name),
              react.createElement("span", { style: S.cellMeta }, isDir ? "" : fmtSize(entry.size)),
              react.createElement("span", { style: { ...S.cellMeta, flex: "0 0 118px", textAlign: "right" } }, fmtTime(entry.mtime)),
              // 行尾下载：拖不出去时的替代入口（很多环境禁止往外拖）。
              react.createElement(
                "span",
                {
                  style: S.rowAction,
                  title: `下载「${entry.name}」到${destLabel}`,
                  onClick: (event) => {
                    event.stopPropagation();
                    void startPull([full]);
                  },
                },
                "⬇",
              ),
            ),
          );
        }

        const previewNode = (() => {
          // 编辑态优先：此时不看预览。
          if (draft !== null) {
            const dirty = draft.text !== draft.original;
            const bar = [
              react.createElement(
                "button",
                {
                  key: "save",
                  type: "button",
                  style: { ...S.button, opacity: draft.busy ? 0.6 : 1 },
                  disabled: draft.busy,
                  onClick: () => void saveEdit(),
                },
                draft.busy ? "保存中…" : "保存",
              ),
              react.createElement(
                "button",
                { key: "cancel", type: "button", style: S.button, onClick: () => setDraft(null) },
                "取消",
              ),
              react.createElement("span", { key: "path", style: S.editorPath }, draft.path),
            ];
            if (dirty) bar.push(react.createElement("span", { key: "dirty", style: S.editorBadge }, "未保存"));
            const nodes = [
              react.createElement("div", { key: "bar", style: S.editorBar }, bar),
              react.createElement("textarea", {
                key: "area",
                style: S.editorArea,
                value: draft.text,
                spellCheck: false,
                onChange: (event) =>
                  setDraft((previous) =>
                    previous === null ? previous : { ...previous, text: event.target.value, note: "" },
                  ),
                onKeyDown: onDraftKeyDown,
              }),
            ];
            if (draft.error) nodes.push(react.createElement("div", { key: "err", style: S.banner }, draft.error));
            if (draft.note) nodes.push(react.createElement("div", { key: "note", style: S.editorNote }, draft.note));
            return react.createElement("div", { style: S.editorWrap }, nodes);
          }
          if (preview === null) {
            return react.createElement("div", { style: S.hint }, "点左侧文件名即可预览，预览后可以点「编辑」直接改");
          }
          if (preview.loading) {
            return react.createElement("div", { style: S.hint }, "读取中…");
          }
          if (preview.ok === false) {
            return react.createElement("div", { style: S.banner }, preview.error || "读取失败");
          }
          if (preview.binary) {
            return react.createElement(
              "div",
              { style: S.hint },
              `二进制文件，无法预览\n${preview.path}\n${fmtSize(preview.size)}`,
            );
          }
          const label = `${preview.path}  ·  ${fmtSize(preview.size)}${preview.truncated ? "（已截断）" : ""}`;
          // 被截断的文件不给编辑入口：草稿只是一部分，存回去会把文件锯短。
          if (preview.truncated) {
            return react.createElement(
              "div",
              null,
              react.createElement("div", { style: S.head }, label),
              react.createElement(
                "div",
                { style: S.hint },
                `文件超过 ${fmtSize(MAX_EDIT_BYTES)}，只显示了开头一部分，不能在这里编辑。`,
              ),
              react.createElement("pre", { style: S.pre }, preview.text ?? ""),
            );
          }
          return react.createElement(
            "div",
            null,
            react.createElement(
              "div",
              { style: { ...S.head, display: "flex", alignItems: "center", gap: 8 } },
              react.createElement(
                "span",
                { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                label,
              ),
              react.createElement(
                "button",
                {
                  type: "button",
                  style: S.button,
                  onClick: () => void startPull([preview.path]),
                  title: `把这个文件下载到${destLabel}`,
                },
                "⬇ 下载",
              ),
              react.createElement("button", { type: "button", style: S.button, onClick: startEdit }, "编辑"),
            ),
            react.createElement("pre", { style: S.pre }, preview.text ?? ""),
          );
        })();

        const overCurrent = dropTarget === state.path;

        children.push(
          react.createElement(
            "div",
            {
              key: "body",
              style: {
                ...S.body,
                ...(overCurrent ? S.listDropping : null),
                position: "relative",
              },
              // 整个浏览区都是落点：拖到空白处 = 传到当前目录。
              onDragOver: (event) => onAreaDragOver(event, state.path),
              onDragLeave: onAreaDragLeave,
              onDrop: (event) => onAreaDrop(event, state.path),
            },
            react.createElement(
              "div",
              {
                style: {
                  ...S.list,
                  flex: "0 0 auto",
                  width: listWidth,
                  // 选中时底部留出浮条的高度，最后一两行不会被浮条盖住；
                  // 只加内边距、不动已有行的位置，所以选中前后列表不会跳。
                  ...(selected.length > 0 ? { paddingBottom: 56 } : null),
                },
                // 点空白处 = 取消选择（点行也会冒泡上来，用 target===currentTarget 区分）。
                onClick: (event) => {
                  if (event.target === event.currentTarget) setSelected([]);
                },
                // 空白处右键 = 新建文件 / 新建文件夹（行的右键有自己的菜单，这里先筛掉）。
                onContextMenu: (event) => {
                  if (event.target !== event.currentTarget) return;
                  onBlankContextMenu(event, state.path);
                },
              },
              listRows,
            ),
            react.createElement(VSplit, {
              key: "split-list",
              value: listWidth,
              min: 200,
              max: 4000,
              onChange: setListWidth,
            }),
            react.createElement("div", { style: S.preview }, previewNode),
            // 选中提示浮条：绝对定位在浏览区左下角，浮在列表之上，不参与布局，
            // 所以「选中 / 取消选中」不会把下面的文件往下挤。
            selected.length > 0
              ? react.createElement(
                  "div",
                  { style: S.selFloat },
                  react.createElement(
                    "span",
                    { style: S.selHint },
                    `已选 ${selected.length} 项 · Ctrl+点击加选 · 拖出去=下载`,
                  ),
                  react.createElement(
                    "button",
                    {
                      style: S.selButton,
                      onClick: () => setConfirmDelete(selected.slice()),
                      title: "删除选中的文件/文件夹（远端删除不可恢复）",
                    },
                    `🗑 删除 ${selected.length} 项`,
                  ),
                  react.createElement(
                    "button",
                    { style: S.button, onClick: () => setSelected([]), title: "取消选择" },
                    "取消选择",
                  ),
                )
              : null,
            overCurrent
              ? react.createElement(
                  "div",
                  { style: S.dropOverlay },
                  `松手传到 ${state.path}`,
                )
              : null,
          ),
        );
      }

      /**
       * 把主内容与底部终端拼成一列。终端关着时原样返回，所以「文件」和「AI 对话」
       * 两种布局都共用同一段代码，不用各写一遍。
       */
      const withTerminal = (body) => {
        if (!termOpen) return body;
        return react.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } },
          body,
          react.createElement(HSplit, {
            key: "split-term",
            value: termHeight,
            min: 120,
            max: 900,
            invert: true,
            onChange: setTermHeight,
          }),
          react.createElement(
            "div",
            { style: { flex: "0 0 auto", height: termHeight, display: "flex", minHeight: 0 } },
            react.createElement(TerminalPanel, {
              connection: currentConnection,
              onClose: () => setTermOpen(false),
            }),
          ),
        );
      };

      /** 右下角的传输抽屉。浮在整页之上，所以「文件」和「AI 对话」两种布局都挂同一个。 */
      const transferDrawer = react.createElement(TransferDrawer, {
        jobs,
        open: drawerOpen,
        onClose: () => setDrawerOpen(false),
        onCancel: (id) => void cancelJob(id),
        onReveal: (path) => void revealPath(path),
        onDismiss: (id) => setJobs((previous) => previous.filter((job) => job.id !== id)),
      });

      /** 连接管理浮层（删除设备）。和传输抽屉一样浮在整页之上，两种布局都挂同一个。 */
      const manager = react.createElement(ConnectionManager, {
        open: manageOpen,
        connections: state.connections,
        hidden: state.hidden,
        pendingDelete,
        onAskDelete: (id) => setPendingDelete(id),
        onCancelDelete: () => setPendingDelete(null),
        onDelete: (item) => void removeConnection(item),
        onRestore: (item) => void restoreConnection(item),
        onClose: () => {
          setManageOpen(false);
          setPendingDelete(null);
        },
      });

      /**
       * 右键菜单。点空白处或再右键一次就关；位置夹在窗口内，免得贴边被截掉。
       *
       * 两种形态：点在行上 → 下载 / 重命名（只选了一条时）/ 删除；
       * 点在空白处 → 新建文件 / 新建文件夹（落在当前目录）。
       */
      const rowMenuNode = (() => {
        if (rowMenu === null) return null;
        const view = typeof window === "undefined" ? null : window;
        const limitX = view !== null && Number(view.innerWidth) > 0 ? Number(view.innerWidth) - 230 : rowMenu.x;
        const limitY = view !== null && Number(view.innerHeight) > 0 ? Number(view.innerHeight) - 210 : rowMenu.y;
        const left = Math.max(6, Math.min(rowMenu.x, limitX));
        const top = Math.max(6, Math.min(rowMenu.y, limitY));
        const paths = Array.isArray(rowMenu.paths) ? rowMenu.paths : [];
        const blank = paths.length === 0;
        const targetDir = blank ? String(rowMenu.dir || state.path) : "";
        const title = blank
          ? `新建 · ${baseName(targetDir) || targetDir}`
          : paths.length === 1
            ? baseName(paths[0])
            : `已选 ${paths.length} 项`;
        const items = [];
        if (blank) {
          items.push(
            react.createElement(
              "button",
              {
                key: "new-file",
                type: "button",
                style: S.menuItem,
                onClick: () => {
                  setRowMenu(null);
                  openPrompt("newfile", { dir: targetDir });
                },
              },
              "📄 新建文件…",
            ),
            react.createElement(
              "button",
              {
                key: "new-dir",
                type: "button",
                style: S.menuItem,
                onClick: () => {
                  setRowMenu(null);
                  openPrompt("newdir", { dir: targetDir });
                },
              },
              "📁 新建文件夹…",
            ),
          );
        } else {
          items.push(
            react.createElement(
              "button",
              {
                key: "download",
                type: "button",
                style: S.menuItem,
                onClick: () => {
                  setRowMenu(null);
                  void startPull(paths);
                },
              },
              `⬇ 下载到${destLabel}`,
            ),
          );
          if (paths.length === 1) {
            items.push(
              react.createElement(
                "button",
                {
                  key: "rename",
                  type: "button",
                  style: S.menuItem,
                  onClick: () => {
                    setRowMenu(null);
                    openPrompt("rename", { target: paths[0] });
                  },
                },
                "✏️ 重命名…",
              ),
            );
          }
          items.push(
            react.createElement(
              "button",
              {
                key: "delete",
                type: "button",
                style: S.menuItemDanger,
                onClick: () => {
                  setRowMenu(null);
                  setConfirmDelete(paths);
                },
              },
              paths.length > 1 ? `🗑 删除 ${paths.length} 项` : "🗑 删除",
            ),
            react.createElement(
              "button",
              {
                key: "clear",
                type: "button",
                style: S.menuItem,
                onClick: () => {
                  setRowMenu(null);
                  setSelected([]);
                },
              },
              "取消选择",
            ),
          );
        }
        return react.createElement(
          "div",
          {
            key: "row-menu",
            style: S.menuBackdrop,
            onClick: () => setRowMenu(null),
            onContextMenu: (event) => {
              if (typeof event.preventDefault === "function") event.preventDefault();
              setRowMenu(null);
            },
          },
          react.createElement(
            "div",
            {
              key: "card",
              style: { ...S.menuCard, left, top },
              onClick: (event) => event.stopPropagation(),
            },
            react.createElement("div", { key: "title", style: S.menuTitle }, title),
            ...items,
          ),
        );
      })();

      /** 删除确认：远端删掉就找不回来了，所以一定二次确认。 */
      const confirmNode =
        confirmDelete === null
          ? null
          : react.createElement(
              "div",
              {
                key: "confirm-delete",
                style: S.managerBackdrop,
                onClick: (event) => {
                  if (event.target === event.currentTarget) setConfirmDelete(null);
                },
              },
              react.createElement(
                "div",
                {
                  key: "card",
                  style: { ...S.managerCard, gap: 10 },
                  onClick: (event) => event.stopPropagation(),
                },
                react.createElement(
                  "div",
                  { key: "title", style: { fontWeight: 600, fontSize: 13 } },
                  `删除 ${confirmDelete.length} 项？`,
                ),
                react.createElement(
                  "div",
                  { key: "note", style: S.connHint },
                  "远端删除不可恢复；选中的文件夹会连同里面的内容一起删掉。",
                ),
                react.createElement(
                  "div",
                  { key: "names", style: { ...S.connHint, maxHeight: 132, overflow: "auto", wordBreak: "break-all" } },
                  confirmDelete.map((path) => baseName(path)).join("、"),
                ),
                react.createElement(
                  "div",
                  { key: "actions", style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
                  react.createElement(
                    "button",
                    { type: "button", style: S.selButton, onClick: () => void performDelete(confirmDelete) },
                    `删除 ${confirmDelete.length} 项`,
                  ),
                  react.createElement(
                    "button",
                    { type: "button", style: S.button, onClick: () => setConfirmDelete(null) },
                    "取消",
                  ),
                ),
              ),
            );

      /** 「输入名字」浮层：新建文件 / 新建文件夹 / 重命名共用，回车确定、Esc 取消。 */
      const promptNode =
        namePrompt === null
          ? null
          : react.createElement(
              "div",
              {
                key: "name-prompt",
                style: S.managerBackdrop,
                onClick: (event) => {
                  if (event.target === event.currentTarget && namePrompt.busy !== true) setNamePrompt(null);
                },
              },
              react.createElement(
                "div",
                {
                  key: "card",
                  style: { ...S.managerCard, gap: 10 },
                  onClick: (event) => event.stopPropagation(),
                },
                react.createElement(
                  "div",
                  { key: "title", style: { fontWeight: 600, fontSize: 13 } },
                  namePrompt.mode === "rename"
                    ? `重命名「${baseName(namePrompt.target)}」`
                    : namePrompt.mode === "newdir"
                      ? "新建文件夹"
                      : "新建文件",
                ),
                react.createElement(
                  "div",
                  { key: "where", style: S.connHint },
                  namePrompt.mode === "rename" ? `同目录改名 · ${namePrompt.dir}` : `位置 · ${namePrompt.dir}`,
                ),
                react.createElement("input", {
                  key: "input",
                  style: S.input,
                  value: namePrompt.value,
                  autoFocus: true,
                  spellCheck: false,
                  placeholder: namePrompt.mode === "newdir" ? "文件夹名字" : "文件名",
                  onFocus: (event) => {
                    if (event.target && typeof event.target.select === "function") event.target.select();
                  },
                  onChange: (event) =>
                    setNamePrompt((previous) =>
                      previous === null ? previous : { ...previous, value: event.target.value, error: null },
                    ),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") {
                      if (typeof event.preventDefault === "function") event.preventDefault();
                      void submitPrompt();
                      return;
                    }
                    if (event.key === "Escape") {
                      if (typeof event.preventDefault === "function") event.preventDefault();
                      if (namePrompt.busy !== true) setNamePrompt(null);
                    }
                  },
                }),
                namePrompt.error
                  ? react.createElement("div", { key: "err", style: S.banner }, namePrompt.error)
                  : null,
                react.createElement(
                  "div",
                  { key: "actions", style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
                  react.createElement(
                    "button",
                    {
                      type: "button",
                      style: { ...S.selButton, opacity: namePrompt.busy === true ? 0.6 : 1 },
                      disabled: namePrompt.busy === true,
                      onClick: () => void submitPrompt(),
                    },
                    namePrompt.busy === true ? "处理中…" : "确定",
                  ),
                  react.createElement(
                    "button",
                    { type: "button", style: S.button, onClick: () => setNamePrompt(null) },
                    "取消",
                  ),
                ),
              ),
            );

      /** 所有浮层（传输抽屉、连接管理、右键菜单、删除确认、新建/重命名输入框）两种布局都挂同一份。 */
      const overlays = [transferDrawer, manager, rowMenuNode, confirmNode, promptNode];

      // 「AI 对话」：不再整页替换，改成停靠在右侧的可拉伸面板，左边文件页原样保留。
      if (view === "chat") {
        return react.createElement(
          "div",
          { style: S.root },
          withTerminal(
            react.createElement(
              "div",
              { style: S.body },
              react.createElement("div", { style: S.dockMain }, children),
              react.createElement(VSplit, {
                key: "split-chat",
                value: chatWidth,
                min: 280,
                max: 2000,
                invert: true,
                onChange: setChatWidth,
              }),
              react.createElement(
                "div",
                { style: { ...S.dockChat, width: chatWidth } },
                react.createElement(ChatPanel, {
                  connection: currentConnection,
                  path: state.path,
                  onBack: () => setView("files"),
                  docked: true,
                }),
              ),
            ),
          ),
          ...overlays,
        );
      }

      return react.createElement("div", { style: S.root }, withTerminal(children), ...overlays);
    }

    // ───────────────────────────────────────────────── 插件入口

    /** 需要客户端侧的服务：槽位注册表。 */
    const inject = ["slots"];

    /**
     * 注册活动栏入口和它打开的主面板。
     * @param ctx - 浏览器侧插件上下文。
     */
    function apply(ctx) {
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 50,
            label: "SSH 远程资源管理器",
          },
          ExplorerIcon,
        ),
      );

      ctx.slots.inject("main", () =>
        ctx.slots.register(
          {
            name: "main",
            key: PANEL_ID,
          },
          ExplorerPanel,
        ),
      );
    }

    exports.name = "ssh-explorer";
    exports.inject = inject;
    exports.apply = apply;
    exports.PANEL_ID = PANEL_ID;
    // 下面两个导出只给同目录的 test_client.mjs 做渲染冒烟测试用，DSH 运行时只读
    // name / inject / apply 三个字段，多导出不会影响加载。
    exports.ExplorerPanel = ExplorerPanel;
    exports.ExplorerIcon = ExplorerIcon;
    return module.exports;
  },
});
