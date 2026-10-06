#!/usr/bin/env python3
"""用户在向导里取消时，整条链路必须干净收尾：退出码 3，且不挂住。

要验证的行为：Go 在向导阶段被 Ctrl+C 时不会去放行门闸，而后台执行子 shell 正阻塞
在门闸上——若 bash 侧不补一次放行，wait 会永远挂住，用户看到的是「取消了但命令
不返回」。install.sh 在 wait 之前补了 `printf '\\n' > "$gate"`。

用法：cancel-check.py <dsh-installer 路径>
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import tempfile
import termios
import threading
import time

REPLIES = (
    (b"\x1b[6n", b"\x1b[1;1R"),
    (b"\x1b]11;?", b"\x1b]11;rgb:0000/0000/0000\x1b\\"),
    (b"\x1b]10;?", b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
)


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DSH_INSTALLER_BIN", "")
    if not binary or not os.path.exists(binary):
        print("missing-binary", file=sys.stderr)
        return 2

    work = tempfile.mkdtemp(prefix="dsh-cancel-")
    logfile = os.path.join(work, "exec.log")
    open(logfile, "w").write("")
    summary = os.path.join(work, "summary.txt")
    open(summary, "w").write("")
    answers = os.path.join(work, "answers.env")
    gate = os.path.join(work, "gate")
    os.mkfifo(gate)

    released = threading.Event()

    def reader():
        # 与 install.sh 的后台执行体一样：阻塞等放行。
        fd = os.open(gate, os.O_RDONLY)
        try:
            select.select([fd], [], [], 30)
            os.read(fd, 64)
            released.set()
        finally:
            os.close(fd)

    threading.Thread(target=reader, daemon=True).start()

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.chdir(work)
        os.execv(binary, [
            binary, "--dir", work,
            "--answers-file", answers,
            "--run-gate", gate,
            "--watch-log", logfile,
            "--watch-summary-file", summary,
            "--watch-sentinel", "__DSH_EXEC_DONE__",
            "--watch-title", "安装 DSH",
        ])
        os._exit(127)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    buf = b""
    end = time.time() + 6
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        for q, a in REPLIES:
            if q in chunk:
                try:
                    os.write(fd, a)
                except OSError:
                    pass

    # 向导第一页上按 Ctrl+C。
    try:
        os.write(fd, b"\x03")
    except OSError:
        pass

    # 等子进程退出，并取退出码。
    #
    # 注意：子进程一退出，PTY 主端的 read() 会抛 EIO（而不是返回空）。
    # 早先的写法在这里 break 掉整个循环，于是永远走不到 waitpid，把「已经退出」
    # 误判成「挂住」——所以要把 EOF/EIO 与「还没退出」分开处理。
    status = None
    deadline = time.time() + 10
    eof = False
    while time.time() < deadline:
        if not eof:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    if not os.read(fd, 65536):
                        eof = True
                except OSError:
                    eof = True
        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            status = st
            break
        time.sleep(0.05)
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        print("界面被 Ctrl+C 后没有退出（挂住了）", file=sys.stderr)
        return 1

    code = os.waitstatus_to_exitcode(status)
    print(f"exit={code} gate_released={int(released.is_set())}")
    if code != 3:
        print(f"取消的退出码必须是 3，实际 {code}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
