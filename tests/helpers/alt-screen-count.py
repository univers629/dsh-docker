#!/usr/bin/env python3
"""数一次完整安装会话里备用屏幕的进出次数。

要验证的行为：向导与执行视图由**同一个** tea.Program 承载，所以整场只应出现
一次 CSI ?1049h（进入）与一次 CSI ?1049l（离开）。两次程序调用会是 2 进 2 出，
而且两次之间会有一段输出漏到备用屏幕之外的终端行里。

做法：在 PTY 里跑真实的 dsh-installer，喂按键推进向导；日志与摘要预先写好并带上
结束标记，于是执行视图一进来就收尾，不必真的装东西。全程数 CSI 序列。

用法：alt-screen-count.py <dsh-installer 路径>
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

ENTER = b"\x1b[?1049h"
LEAVE = b"\x1b[?1049l"

# 终端能力查询必须回答，否则界面可能停在等待回复上。
REPLIES = (
    (b"\x1b[6n", b"\x1b[1;1R"),
    (b"\x1b]11;?", b"\x1b]11;rgb:0000/0000/0000\x1b\\"),
    (b"\x1b]10;?", b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
)


def start_gate_reader(gate, stop):
    """在后台阻塞读门闸，模拟 install.sh 那边的执行子 shell。

    Go 在向导确认后会打开 FIFO 写端放行；没有读端时它会重试到超时并报错。
    """

    def body():
        try:
            fd = os.open(gate, os.O_RDONLY)
        except OSError:
            return
        try:
            while not stop.is_set():
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        if not os.read(fd, 64):
                            break
                    except OSError:
                        break
        finally:
            os.close(fd)

    t = threading.Thread(target=body, daemon=True)
    t.start()
    return t


def run(binary, rows=24, cols=100, max_sec=25.0):
    work = tempfile.mkdtemp(prefix="dsh-altscreen-")

    logfile = os.path.join(work, "exec.log")
    with open(logfile, "w", encoding="utf-8") as f:
        f.write("==> 正在启动 DSH...\n")
        f.write("==> 多用户模式：注册门槛=open。\n")
        f.write("__DSH_EXEC_DONE__:0\n")
    summaryfile = os.path.join(work, "summary.txt")
    with open(summaryfile, "w", encoding="utf-8") as f:
        f.write("本机入口: http://127.0.0.1:3080\n")

    answers = os.path.join(work, "answers.env")
    gate = os.path.join(work, "gate")
    os.mkfifo(gate)
    stop = threading.Event()
    start_gate_reader(gate, stop)

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.chdir(work)
        os.execv(
            binary,
            [
                binary,
                "--dir", work,
                "--answers-file", answers,
                "--run-gate", gate,
                "--watch-log", logfile,
                "--watch-summary-file", summaryfile,
                "--watch-sentinel", "__DSH_EXEC_DONE__",
                "--watch-title", "安装 DSH",
            ],
        )
        os._exit(127)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    buf = b""
    deadline = time.time() + max_sec
    sent = 0
    next_key_at = time.time() + 1.2
    seen_exec = False
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
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
            # 执行视图独有的操作提示（向导页只有「↑/↓ 选择 | Enter 确认 | Ctrl+C 退出」），
            # 用它判断已经原地切页。
            if b"PgUp/PgDn" in chunk:
                seen_exec = True

        if LEAVE in buf:
            break
        # 向导期间才需要按键：切到执行视图后回车会去点「退出」，那正好也是我们要的
        # 最后一步，所以额外放行几次。
        if time.time() >= next_key_at and sent < 12:
            try:
                os.write(fd, b"\r")
            except OSError:
                break
            sent += 1
            next_key_at = time.time() + 0.7

    # 给它时间自然收尾。
    end = time.time() + 5
    while time.time() < end and LEAVE not in buf:
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

    stop.set()
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    return buf, seen_exec


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DSH_INSTALLER_BIN", "")
    if not binary or not os.path.exists(binary):
        print("missing-binary", file=sys.stderr)
        return 2
    data, seen_exec = run(binary)
    enter = data.count(ENTER)
    leave = data.count(LEAVE)
    print(f"enter={enter} leave={leave} exec={int(seen_exec)} bytes={len(data)}")
    if enter == 0:
        print("界面未进入备用屏幕，可能没有启动成功", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
