#!/usr/bin/env bash
# 端到端验证「撤销授权后 provider 真的从 settings.yaml 消失」。
#
# 单元测试只能证明 planSeed 返回了正确的 removals 路径；真正删除发生在
# seed-dsh-model-settings.mjs 里（deleteIn + 清理空父节点）。这里跑真实脚本，
# 断言写出来的 YAML 里那条路由确实没了，而用户手写的直连供应商还在。
#
# 被测文件从**仓库**取（$1 = 仓库根，默认当前目录），不要用 /usr/local/lib/dsh 下
# 那份：那是镜像里安装好的旧版本，用它测等于什么都没测。
set -eu

repo="${1:-$(pwd)}"
lib="$repo/bin"
for f in seed-dsh-model-settings.mjs dsh-model-settings-policy.mjs; do
  [ -f "$lib/$f" ] || { echo "  ✗ 找不到 $lib/$f"; exit 2; }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

home="$work/home"
mkdir -p "$home"

# 初始状态：两条代理路由（alpha / beta）+ 一条用户手写的直连供应商
cat > "$home/settings.yaml" <<'YAML'
llm-pi-ai:
  providers:
    alpha:
      baseURL: http://dsh-key-broker:8080/u/alpha
      apiKeyEnv: ALPHA_API_KEY
    beta:
      baseURL: http://dsh-key-broker:8080/u/beta
      apiKeyEnv: BETA_API_KEY
    mine:
      baseURL: https://my-own.example/v1
      apiKeyEnv: MINE_API_KEY
YAML
: > "$home/.credentials.yaml"

run_seed() {
  printf '%s' "$1" | base64 -d | node "$lib/seed-dsh-model-settings.mjs" --home "$home" >/dev/null 2>&1 || true
}

payload() {
  # $1 = 逗号分隔的上游名
  local names="$1"
  local ups=""
  local IFS=','
  for n in $names; do
    [ -n "$n" ] || continue
    ups="${ups}${ups:+,}{\"name\":\"$n\",\"shape\":\"any\",\"models\":[\"m1\"]}"
  done
  printf '{"brokerBase":"http://dsh-key-broker:8080","placeholder":"dsh-broker-placeholder","upstreams":[%s],"extraHeaders":{"x-dsh-instance-token":"t"}}' "$ups" | base64 -w0
}

echo "  [1] 授权 alpha + beta（两条都该在）"
run_seed "$(payload 'alpha,beta')"
for n in alpha beta mine; do
  if grep -qE "^    $n:" "$home/settings.yaml"; then echo "      ✓ $n 存在"; else echo "      ✗ $n 丢失"; fi
done

echo "  [2] 只授权 alpha（beta 被撤销，必须消失；mine 是手写的，必须保留）"
run_seed "$(payload 'alpha')"
if grep -qE '^    beta:' "$home/settings.yaml"; then
  echo "      ✗ beta 仍在 —— 撤销授权没生效"
  exit 1
else
  echo "      ✓ beta 已删除"
fi
grep -qE '^    alpha:' "$home/settings.yaml" && echo "      ✓ alpha 保留" || { echo "      ✗ alpha 被误删"; exit 1; }
grep -qE '^    mine:' "$home/settings.yaml" && echo "      ✓ mine（手写）保留" || { echo "      ✗ mine 被误删"; exit 1; }

echo "  [3] 全部撤销（alpha 也该消失；mine 仍在）"
run_seed "$(payload '')"
if grep -qE '^    alpha:' "$home/settings.yaml"; then
  echo "      ✗ alpha 仍在"
  exit 1
else
  echo "      ✓ alpha 已删除"
fi
grep -qE '^    mine:' "$home/settings.yaml" && echo "      ✓ mine（手写）保留" || { echo "      ✗ mine 被误删"; exit 1; }

echo "  [4] 重新授权 alpha（应重新出现）"
run_seed "$(payload 'alpha')"
grep -qE '^    alpha:' "$home/settings.yaml" && echo "      ✓ alpha 已恢复" || { echo "      ✗ alpha 未恢复"; exit 1; }

echo
echo "  端到端通过：撤销生效、手写供应商不受影响、重新授权可用"
