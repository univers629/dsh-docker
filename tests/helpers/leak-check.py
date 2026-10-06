#!/usr/bin/env python3
"""确认安装失败时，终端上不再出现泄漏到备用屏幕之外的输出。

被修复的缺陷（在真实部署上观察到的现象）：

    ==> 多用户模式：注册门槛=open，闲置停用=3600s，每用户配额=2GB。
    安装未完成（退出码 1）
    完整日志: /tmp/dsh-exec-BgTWVQ.log

前两行来自执行阶段，第三行来自退出执行视图后的 printf。它们本该在页面里，
但备用屏幕一还原，这些内容就落到了终端行上——而那时用户已经滚过去了。

做法：跑完整交互路径，失败结束（结束标记带非零退出码），然后检查**备用屏幕之外**
的字节流——也就是最后一次 CSI ?1049l 之后的内容。那里应当只剩日志路径一句。

用法：leak-check.py <dsh-installer 路径>
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import threading
import time

LEAVE = b"\x1b[?1049l"
ENTER = b"\x1b[?1049h"
REPLIES = (
    (b"\x1b[6n", b"\x1b[1;1R"),
    (b"\x1b]11;?", b"\x1b]11;rgb:0000/0000/0000\x1b\\"),
    (b"\x1b]10;?", b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
)


def strip_ansi(data: bytes) -> str:
    text = data.decode("utf-8", "replace")
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text)
    text = re.sub(r"\x1b[()][A-Z0-9]", "", text)
    return text


def run(binary, exit_code=1, rows=24, cols=100, max_sec=25.0):
    work = tempfile.mkdtemp(prefix="dsh-leak-")

    logfile = os.path.join(work, "exec.log")
    with open(logfile, "w", encoding="utf-8") as f:
        f.write("==> 多用户模式：注册门槛=open，闲置停用=3600s，每用户配额=2GB。\n")
        f.write("[错误] DSH 容器启动失败，原配置未被覆盖。\n")
        # 结束标记在**末尾**，最后的换行让执行视图能读到它。
        f.write(f"__DSH_EXEC_DONE__:{exit_code}\n")
    summaryfile = os.path.join(work, "summary.txt")
    with open(summaryfile, "w", encoding="utf-8") as f:
        f.write("模型密钥面板: http://127.0.0.1:3081\n")
        f.write(f"安装未完成（退出码 {exit_code}）\n")
        f.write(f"完整日志: {logfile}\n")

    answers = os.path.join(work, "answers.env")
    gate = os.path.join(work, "gate")
    os.mkfifo(gate)
    stop = threading.Event()

    def reader():
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
            "--watch-summary-file", summaryfile,
            "--watch-sentinel", "__DSH_EXEC_DONE__",
            "--watch-title", "安装 DSH",
        ])
        os._exit(127)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    buf = b""
    deadline = time.time() + max_sec
    sent = 0
    next_key = time.time() + 1.2
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
        if sent < 10 and time.time() >= next_key:
            try:
                os.write(fd, b"\r")
            except OSError:
                break
            sent += 1
            next_key = time.time() + 0.7
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
    return buf


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DSH_INSTALLER_BIN", "")
    if not binary or not os.path.exists(binary):
        print("missing-binary", file=sys.stderr)
        return 2
    data = run(binary)
    if LEAVE not in data:
        print("没有观察到离开备用屏幕，界面可能没起来", file=sys.stderr)
        return 1
    after = data.rsplit(LEAVE, 1)[1]
    text = strip_ansi(after).strip()
    print(f"after-leave={text!r}")
    # 失败摘要属于页面内容，不得出现在备用屏幕之外。
    for banned in ("安装未完成", "多用户模式", "DSH 容器启动失败", "==>"):
        if banned in text:
            print(f"泄漏：失败摘要「{banned}」出现在备用屏幕之外", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
