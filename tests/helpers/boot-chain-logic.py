#!/usr/bin/env python3
"""决定性的场景测试：属主是运行账户 + 组可写 + 只读挂载 → 必须判通过。

这正是真实部署里出现的组合：
  compose 把 ./bin/dsh-supervisor 以 :ro 挂进容器，挂载源的属主跟着 clone 的人走
  （非 root 用户 clone → 1000:1000 0775），容器里 uid 1000 恰好是 dsh。
  只看 stat 会判失败，而它是只读挂载，实际写不动。

同时验证反面：同样的属主与权限位，**不是**只读挂载时必须判失败——否则修复就
把判定放宽成了永远通过。
"""
import importlib.util
import os
import shutil
import sys
import tempfile

# 被测文件由调用方给出（默认取仓库内的相对位置），不要在脚本里写死 /tmp 路径：
# 那样只有恰好把文件放在 /tmp 时才跑得起来，进了套件就是永远跳过。
here = os.path.dirname(os.path.abspath(__file__))
default_verifier = os.path.normpath(os.path.join(here, "..", "..", "bin", "verify-dsh-hardening"))
verifier_path = sys.argv[1] if len(sys.argv) > 1 else default_verifier
if not os.path.exists(verifier_path):
    print(f"  ✗ 找不到被测文件：{verifier_path}")
    sys.exit(2)

src = open(verifier_path, encoding="utf-8").read()
cut = src.index("def check_signal_isolation():")
vh = importlib.util.module_from_spec(importlib.util.spec_from_loader("vh", loader=None))
exec(compile(src[:cut], "vh", "exec"), vh.__dict__)

failures = []


def expect(cond, msg):
    print(("    ✓ " if cond else "    ✗ ") + msg)
    if not cond:
        failures.append(msg)


work = tempfile.mkdtemp(prefix="bootchain-")
target = os.path.join(work, "dsh-supervisor")
with open(target, "w") as f:
    f.write("#!/bin/sh\n")
os.chmod(target, 0o775)
if os.geteuid() == 0:
    os.chown(target, 1000, 1000)

saved_paths, saved_run, saved_mounts, saved_record = (
    vh.BOOT_CHAIN_PATHS, vh.run_account, vh.read_only_mounts, vh.record,
)
captured = {}
try:
    vh.BOOT_CHAIN_PATHS = (target,)
    vh.run_account = lambda: (1000, 1000)   # 容器里 uid 1000 就是 dsh
    vh.record = lambda name, ok, detail: captured.update(ok=ok, detail=detail)

    print("  [1] 属主 dsh + 0775 + **只读挂载** → 必须通过（真实部署的组合）")
    vh.read_only_mounts = lambda: {target}
    captured.clear()
    vh.check_boot_chain()
    expect(captured.get("ok") is True, f"只读挂载应判通过（实际 ok={captured.get('ok')}，detail={captured.get('detail')}）")

    print("  [2] 属主 dsh + 0775 + **非只读挂载** → 必须失败（不能放宽）")
    vh.read_only_mounts = lambda: set()
    captured.clear()
    vh.check_boot_chain()
    expect(captured.get("ok") is False, f"可写路径必须判失败（实际 ok={captured.get('ok')}）")
    detail = captured.get("detail", "")
    expect("属主是 dsh" in detail, f"失败原因应点出属主（实际：{detail}）")
    expect("0775" in detail, f"失败原因应点出权限位（实际：{detail}）")

    print("  [3] 祖先目录只读 → 也必须通过")
    vh.read_only_mounts = lambda: {work}   # 只挂父目录
    captured.clear()
    vh.check_boot_chain()
    expect(captured.get("ok") is True, f"父目录只读时应判通过（实际 ok={captured.get('ok')}）")
finally:
    vh.BOOT_CHAIN_PATHS, vh.run_account, vh.read_only_mounts, vh.record = (
        saved_paths, saved_run, saved_mounts, saved_record,
    )
    shutil.rmtree(work, ignore_errors=True)

print()
if failures:
    print(f"  ✗ {len(failures)} 项未通过")
    sys.exit(1)
print("  ✓ 只读挂载被正确排除，非只读路径仍判失败（既修了误报，也没放宽判定）")
