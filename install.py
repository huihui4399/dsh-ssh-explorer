#!/usr/bin/env python3
"""
安装 / 卸载 dsh-ssh-explorer 插件（DSH 桌面版 profile）。

做两件事：
  1. 把 `plugin\\` 复制到  %USERPROFILE%\\.dsh\\profiles\\desktop\\plugins\\dsh-ssh-explorer\\
  2. 往 profile 的 cordis.patch.yml 末尾追加一段 `- insert:` 装载块（幂等，已存在则跳过）

为什么补丁行用「profile 相对路径」：`dsh-client-modules` 的 `locatePkgJson()` 对
`.`/`file:`/绝对路径这类 loader name 走 `nearestPackage()` —— 从该文件的目录逐级向上找
最近的 package.json，读出它的 `dsh.client` 字段，再服务 `exports["./client"]`。
所以相对路径条目同样能带客户端半边（本地插件惯例，与官方 dsh-tool-computer-use 一致）。

用法：
    python install.py             # 安装（幂等）
    python install.py --rollback  # 卸载：删补丁块 + 删部署目录
    python install.py --verify    # 只校验当前状态，不写任何东西
"""

import argparse
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HOME = Path(os.environ.get("USERPROFILE") or Path.home())
PROFILE_DIR = HOME / ".dsh" / "profiles" / "desktop"
SOURCE_DIR = Path(__file__).resolve().parent / "plugin"
TARGET_DIR = PROFILE_DIR / "plugins" / "dsh-ssh-explorer"
PATCH_FILE = PROFILE_DIR / "cordis.patch.yml"

BEGIN = "# [ssh-explorer] begin"
END = "# [ssh-explorer] end"

# rev 是客户端 bundle 的缓存破坏版本号：改了 lib/client.js 就把它 +1，
# 否则浏览器可能继续用旧的 client.js。**和 package.json 的 version 无关，但要一起往前走。**
#
# 注意：本文件走的是「往 cordis.patch.yml 插 [ssh-explorer] 块」的老路子。
# 现状是插件已经用 **bundle 渠道** 启用了（profile package.json 的
# dsh.profile.bundles 里有 dsh-ssh-explorer，补丁来自包内自带的 cordis.patch.yml）。
# 再跑 install.py 会变成双重挂载 —— 所以它现在只作为「换机器部署」的备份通道，
# 在当前这台机器上**不要跑 install.py**。
# 版本对照：rev 2 = v1.0.0；rev 3 = v1.1.0（可拉伸停靠栏 + 分组模型下拉）；
#           rev 4 = v1.2.x；rev 5 = v1.3.0（双向拖拽传文件）；rev 6 = v1.4.0（删除设备 / 连接管理）；
#           rev 7 = v1.4.1（上传入口合并成一个菜单）；rev 8 = v1.5.0（单击/Ctrl 多选 + Del·右键删除）；
#           rev 9 = v1.6.0（空白处右键新建文件/文件夹、右键重命名）；
#           rev 10 = v1.6.1（选中提示改成浮条，不再把文件列表往下挤）；
#           rev 11 = v1.7.0（改名 dsh-ssh-explorer + 公开到 GitHub，路由前缀与面板 id 一并改，
#                             旧状态目录 ~/.dsh/remote-explorer 首次启动自动搬过来）。
BLOCK = """# [ssh-explorer] begin
# SSH 远程资源管理器：宿主路由 /x-ssh-explorer/* + 侧栏面板 ssh-explorer。
# 由本目录的 install.py 安装；python install.py --rollback 卸载。
- insert:
    - id: ssh-explorer
      name: './plugins/dsh-ssh-explorer/lib/index.js'
      config:
        rev: 11
# [ssh-explorer] end
"""

NODE_CANDIDATES = [
    HOME / ".dsh" / "dsh-runtimes" / "dsh-primary-runtime" / "dependencies" / "node" / "bin" / "node.exe",
    Path(r"C:\Program Files\nodejs\node.exe"),
]


def find_node() -> Path | None:
    for candidate in NODE_CANDIDATES:
        if candidate.is_file():
            return candidate
    return None


def read_text(path: Path) -> tuple[str, str]:
    """读文本，容忍 BOM；返回 (内容, 换行符)。"""
    text = path.read_bytes().decode("utf-8-sig")
    newline = "\r\n" if "\r\n" in text else "\n"
    return text.replace("\r\n", "\n"), newline


def write_text(path: Path, text: str, newline: str) -> None:
    """写文本，绝不写 BOM。"""
    path.write_bytes(text.replace("\n", newline).encode("utf-8"))


def has_block(text: str) -> bool:
    return BEGIN in text and END in text


def strip_block(text: str) -> str:
    out, inside = [], False
    for line in text.split("\n"):
        if line.strip() == BEGIN:
            inside = True
            continue
        if line.strip() == END:
            inside = False
            continue
        if not inside:
            out.append(line)
    return "\n".join(out)


def syntax_gate() -> int:
    """用 node --check 过一遍两个 JS 文件 + 校验 package.json。"""
    node = find_node()
    if node is None:
        print("[warn] 找不到 node，跳过语法门禁")
        return 0
    files = [SOURCE_DIR / "lib" / "index.js", SOURCE_DIR / "lib" / "client.js"]
    for path in files:
        result = subprocess.run(
            [str(node), "--check", str(path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode != 0:
            print(f"[FAIL] 语法错误 {path}:\n{result.stderr}")
            return 1
        print(f"[ok] 语法通过 {path.name}")
    result = subprocess.run(
        [str(node), "-e", f"JSON.parse(require('fs').readFileSync({str(SOURCE_DIR / 'package.json')!r},'utf8'))"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        print(f"[FAIL] package.json 不是合法 JSON:\n{result.stderr}")
        return 1
    print("[ok] 语法通过 package.json")
    return 0


def validate_patch() -> int:
    """用 profile 自带的 yaml 包把 cordis.patch.yml 解析一遍。"""
    node = find_node()
    if node is None:
        return 0
    script = Path(__file__).resolve().parent / "validate_patch.mjs"
    if not script.is_file():
        print("[warn] 找不到 validate_patch.mjs，跳过 YAML 校验")
        return 0
    result = subprocess.run(
        [str(node), str(script), str(PATCH_FILE)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    print(result.stdout.strip())
    if result.returncode != 0:
        print(result.stderr.strip())
        return 1
    return 0


def do_install() -> int:
    if not SOURCE_DIR.is_dir():
        print(f"[FAIL] 源目录不存在：{SOURCE_DIR}")
        return 1
    if not PROFILE_DIR.is_dir():
        print(f"[FAIL] 找不到 DSH 桌面版 profile：{PROFILE_DIR}")
        return 1

    if syntax_gate() != 0:
        return 1

    # 1) 部署文件
    if TARGET_DIR.exists():
        shutil.rmtree(TARGET_DIR)
    shutil.copytree(SOURCE_DIR, TARGET_DIR)
    print(f"[ok] 已部署到 {TARGET_DIR}")

    # 2) 装载补丁
    text, newline = read_text(PATCH_FILE)
    if has_block(text):
        print("[--] 补丁块已存在，保持原样")
    else:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = PATCH_FILE.with_name(f"{PATCH_FILE.name}.bak-ssh-explorer-{stamp}")
        shutil.copy2(PATCH_FILE, backup)
        print(f"[ok] 已备份 {backup.name}")
        merged = text.rstrip("\n") + "\n\n" + BLOCK.rstrip("\n") + "\n"
        write_text(PATCH_FILE, merged, newline)
        print(f"[ok] 已把补丁块追加到 {PATCH_FILE}")

    return validate_patch()


def do_rollback() -> int:
    if PATCH_FILE.is_file():
        text, newline = read_text(PATCH_FILE)
        if has_block(text):
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            backup = PATCH_FILE.with_name(f"{PATCH_FILE.name}.bak-uninstall-{stamp}")
            shutil.copy2(PATCH_FILE, backup)
            write_text(PATCH_FILE, strip_block(text).rstrip("\n") + "\n", newline)
            print(f"[ok] 已移除补丁块（备份 {backup.name}）")
        else:
            print("[--] 补丁文件里没有本插件的块")
    else:
        print(f"[--] 补丁文件不存在：{PATCH_FILE}")

    if TARGET_DIR.exists():
        shutil.rmtree(TARGET_DIR)
        print(f"[ok] 已删除 {TARGET_DIR}")
    else:
        print("[--] 部署目录本来就不存在")
    print("\n卸载完成，重启 DSH 后生效。")
    return 0


def do_verify() -> int:
    ok = True
    print(f"profile      : {PROFILE_DIR}  {'存在' if PROFILE_DIR.is_dir() else '缺失'}")
    print(f"插件目录     : {TARGET_DIR}  {'存在' if TARGET_DIR.is_dir() else '缺失'}")
    for name in ("package.json", "lib/index.js", "lib/client.js"):
        path = TARGET_DIR / name
        print(f"  - {name:16s} {'ok' if path.is_file() else '缺失'}")
        ok = ok and path.is_file()
    if PATCH_FILE.is_file():
        text, _ = read_text(PATCH_FILE)
        print(f"补丁块       : {'已存在' if has_block(text) else '不存在'}")
        ok = ok and has_block(text)
    else:
        print(f"补丁块       : 补丁文件缺失 {PATCH_FILE}")
        ok = False
    if syntax_gate() != 0:
        ok = False
    if validate_patch() != 0:
        ok = False
    print("\n结论：" + ("全部就绪" if ok else "有问题，见上面输出"))
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="安装 / 卸载 dsh-ssh-explorer 插件")
    parser.add_argument("--rollback", action="store_true", help="卸载：删补丁块 + 删部署目录")
    parser.add_argument("--verify", action="store_true", help="只校验，不写任何东西")
    args = parser.parse_args()

    if args.rollback:
        return do_rollback()
    if args.verify:
        return do_verify()
    return do_install()


if __name__ == "__main__":
    sys.exit(main())
