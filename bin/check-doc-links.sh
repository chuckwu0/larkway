#!/usr/bin/env bash
# check-doc-links.sh —— 查 markdown 里指向「本地文件」的死链,零依赖。
# 补 ctxlint 的洞:ctxlint 只扫 CLAUDE.md、且把远端路径/git ref/npm 包/仓库标识误判成死链;
# 本脚本只认**仓库内相对路径**链接,跳过 http(s) / 远端绝对路径(/home/..) / ~家目录 / 纯锚点。
#
# 用法:  bash bin/check-doc-links.sh            # 扫全仓 git 跟踪的 *.md(默认排除 docs/archive/)
#        bash bin/check-doc-links.sh a.md b.md  # 只扫指定文件
# 退出码:有死链 = 1(CI / pre-commit 用),干净 = 0。
# 装 pre-commit(每个 clone 跑一次):  git config core.hooksPath .githooks
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

# 文件清单走环境变量(一行一个),避开 bash 3.2 没有 mapfile + heredoc 占用 stdin 的坑。
# 无参数 = 全仓 *.md,排除 archive(历史文档「勿据此行事」,其内部死链不阻断提交)。
if [ "$#" -gt 0 ]; then LIST="$(printf '%s\n' "$@")"; else LIST="$(git ls-files '*.md' ':!:docs/archive/**')"; fi

FILES_ENV="$LIST" python3 - <<'PY'
import os, re, sys
files = [l for l in os.environ.get('FILES_ENV', '').splitlines() if l.strip()]
files = [f for f in files if f.endswith('.md') and os.path.isfile(f)]
link_re = re.compile(r'\]\(\s*([^)]+?)\s*\)')   # ](target) 或 ![alt](target)
bad = []
for f in files:
    base = os.path.dirname(f)
    with open(f, encoding='utf-8') as fh:
        for i, line in enumerate(fh, 1):
            for m in link_re.finditer(line):
                target = m.group(1).strip()
                path = target.split()[0].split('#', 1)[0] if target else ''  # 去 title / 去锚点
                if not path:
                    continue                                   # 纯锚点 #foo
                if re.match(r'^[a-zA-Z][\w+.-]*://', path):
                    continue                                   # http(s):// 等外链
                if path.startswith(('mailto:', '~', '/')):
                    continue                                   # 邮件 / 家目录 / 远端绝对路径,本机不可靠验证
                if not os.path.exists(os.path.normpath(os.path.join(base, path))):
                    bad.append((f, i, target))
if bad:
    print(f"✗ 发现 {len(bad)} 个死链：")
    for f, i, t in bad:
        print(f"  {f}:{i}  →  {t}")
    sys.exit(1)
print(f"✓ {len(files)} 个 markdown 文件，仓库内本地链接全部有效")
PY
