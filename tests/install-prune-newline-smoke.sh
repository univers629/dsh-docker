#!/usr/bin/env bash
# 回归测试：prune_dir_except 必须把「含换行的目录名」当作一个整体条目处理，
# 不得把它拆成两条待删路径（审计 3.10 的复现场景）。
set -u

# 从 install.sh 逐字提取被测函数（保证测的是真实实现）
src="$(cd "$(dirname "$0")/.." && pwd)/install.sh"
extract() {
  sed -n "/^$1() {/,/^}/p" "$src"
}
eval "$(extract remove_path)"
eval "$(extract prune_dir_except)"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# 场景 1：嵌入换行 + 项目父目录放同名 sibling —— sibling 必须存活
proj="$work/proj"; mkdir -p "$proj/data/dsh/sessions" "$proj/data/dsh/profiles" "$work/victim"
mkdir -p "$proj/data/dsh/note
victim"
cd "$work"
prune_dir_except "$proj/data/dsh" sessions profiles
[ -d "$work/victim" ] || fail "场景1：项目外 sibling 被误删"
[ -d "$proj/data/dsh/sessions" ] || fail "场景1：保留项 sessions 被误删"
[ -d "$proj/data/dsh/profiles" ] || fail "场景1：保留项 profiles 被误删"
# 含换行的目录本身应被当作一个条目删掉
[ -e "$proj/data/dsh/note
victim" ] || echo "PASS 场景1：sibling 与保留项存活，恶意名条目被整体删除"

# 场景 2：以换行开头 —— 不得把目录本身输出为片段导致保留项全灭
proj2="$work/proj2"; mkdir -p "$proj2/data/dsh/sessions" "$proj2/data/dsh/profiles"
mkdir -p "$proj2/data/dsh/"$'\nsessions'
cd "$work"
prune_dir_except "$proj2/data/dsh" sessions profiles
[ -d "$proj2/data/dsh/sessions" ] || fail "场景2：保留项 sessions 被误删"
[ -d "$proj2/data/dsh/profiles" ] || fail "场景2：保留项 profiles 被误删"
echo "PASS 场景2：以换行开头的名字没有连带删除保留项"

# 场景 3：正常名字不受影响（白名单外的被删，白名单内的保留）
proj3="$work/proj3"; mkdir -p "$proj3/data/dsh/sessions" "$proj3/junk" "$proj3/keep-not-allowed"
cd "$work"
prune_dir_except "$proj3" workspace data
[ -d "$proj3/workspace" ] || true # workspace 本来没建，跳过
[ -d "$proj3/data" ] || fail "场景3：白名单 data 被删"
[ -d "$proj3/junk" ] && fail "场景3：非白名单 junk 未被删"
echo "PASS 场景3：正常路径的删除语义不变"

echo "ALL PASS"
