#!/usr/bin/env python3
"""用真实 install.sh 走一遍向导路径：选「卸载」→ 确认 → 界面退出 → bash 收尾。

要验证的行为：脚本必须在有限时间内**自行退出**。

触发路径：向导里选「全部删除」并确认后，界面放行门闸并退出；卸载属于维护动作，
执行体判定不需要执行、立刻 return，读端随之关闭。原因见 tests/gate-release-smoke.mjs
顶部的说明（FIFO 写端在无读端时阻塞）。

做法：pty.fork 起 install.sh（它要求控制终端），PATH 前置一个假 docker，
并用桩 installer 冒充 Go 界面——桩的行为与 Go 侧一致：落答案文件、以非阻塞方式
放行门闸、退出。桩自身若用阻塞写，就会挂在门闸上，那样测的就不是 bash 那一侧了。

用法：gate-delete-e2e.py <install.sh 路径>
输出末行：EXIT=<码>（124 表示挂死）
"""
import os
import pty
import select
import shutil
import signal
import sys
import tempfile
import time

# install.sh 用 `container inspect dsh` 判断容器是否存在，退出码 0 等于「已存在」，
# 那会让它在进向导之前就报错退出，走不到门闸。所以 inspect 必须报「不存在」。
FAKE_DOCKER = """#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    inspect|container) exit 1 ;;
  esac
done
exit 0
"""

# 桩 installer：与 Go 界面同语义。非阻塞放行是关键。
STUB = """#!/usr/bin/env bash
set -u
answers="" gate=""
while [ $# -gt 0 ]; do
  case "$1" in
    --answers-file) answers="$2"; shift 2 ;;
    --run-gate) gate="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$answers" ] && printf 'action=delete\\ndelete_scope=all\\ndelete_confirmed=yes\\n' > "$answers"
if [ -n "$gate" ]; then
  exec 9<>"$gate" 2>/dev/null || true
  printf '\\n' >&9 2>/dev/null || true
  exec 9>&- 2>/dev/null || true
fi
exit 0
"""


def main():
    installer = sys.argv[1] if len(sys.argv) > 1 else "install.sh"
    limit = float(sys.argv[2]) if len(sys.argv) > 2 else 40.0

    work = tempfile.mkdtemp(prefix="gate-delete-")
    try:
        bindir = os.path.join(work, "bin")
        proj = os.path.join(work, "proj")
        os.makedirs(bindir)
        os.makedirs(proj)
        with open(os.path.join(proj, "docker-compose.yml"), "w") as f:
            f.write("services: {}\n")

        docker = os.path.join(bindir, "docker")
        with open(docker, "w") as f:
            f.write(FAKE_DOCKER)
        os.chmod(docker, 0o755)

        stub = os.path.join(work, "stub-installer")
        with open(stub, "w") as f:
            f.write(STUB)
        os.chmod(stub, 0o755)

        pid, fd = pty.fork()
        if pid == 0:
            os.environ["TERM"] = "xterm-256color"
            os.environ["PATH"] = bindir + ":" + os.environ.get("PATH", "")
            os.environ["DSH_INSTALLER_BIN"] = stub
            os.environ["DSH_INSTALL_DIR"] = proj
            os.chdir(work)
            # 不带 action 参数：带了会走命令行路径，不经过向导与门闸。
            os.execv("/bin/bash", ["bash", installer, "--dir", proj])
            os._exit(127)

        buf = b""
        deadline = time.time() + limit
        exited = False
        status = None
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    # 子进程退出后 PTY 主端会抛 EIO；这说明它结束了，不是挂住。
                    exited = True
                    break
                if not chunk:
                    exited = True
                    break
                buf += chunk
            # 顺手收尸：脚本一退出就结束，不必等满限时
            done, st = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                status = st
                exited = True
                break

        if not exited:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
            print(buf.decode("utf-8", "replace")[-1200:])
            print("EXIT=124")
            return 0

        if status is None:
            try:
                _, status = os.waitpid(pid, 0)
            except ChildProcessError:
                status = 0
        code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0
        print(f"EXIT={code}")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
