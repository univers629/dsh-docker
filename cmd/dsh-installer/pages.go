package main

// 本文件定义向导的全部页面与它们的跳转关系。
//
// 结构：每个页面的 next 函数决定下一页，因此分支（例如「一键安装」跳过全部配置页）
// 是自然表达，不需要预先把页面拼成数组。历史栈由 wizardModel 维护，Esc 即可回退。

// actionPage 是第一页：选择操作，与 install.sh 的主菜单一一对应。
func actionPage() page {
	return page{
		kind:  pageSelect,
		title: "选择操作",
		choices: []choice{
			{"install", "安装 / 重新配置", "安装 DSH 或按新配置重建容器"},
			{"update", "更新", "升级容器内的 DSH，或换成新镜像重建容器"},
			{"start", "启动", "启动已有容器，不重建"},
			{"stop", "停止", "停止容器，保留可写层与数据"},
			{"restart", "重启", "重启容器，保留可写层与数据"},
			{"logs", "查看日志", "跟随容器日志输出"},
			{"status", "查看状态", "容器、健康检查与访问入口"},
			{"delete", "卸载", "清理容器、镜像、挂载、网络与工程目录"},
			{"model-key", "补填模型 API 密钥", "只新增密钥代理容器，不重建 dsh"},
			{"key-panel", "模型密钥管理面板", "浏览器里填密钥、拉模型列表，不重建 dsh"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["action"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			switch m.answers["action"] {
			case "install":
				p := installModePage()
				return &p
			case "update":
				p := updateModePage()
				return &p
			case "delete":
				p := deleteScopePage()
				return &p
			}
			// 其余动作没有后续页面：交给引擎执行即可。
			p := confirmPage()
			return &p
		},
	}
}

func updateModePage() page {
	return page{
		kind:  pageSelect,
		title: "更新哪一层",
		choices: []choice{
			{"update", "只更新容器内的 DSH", "重装 npm 包，容器和镜像都不动，最快"},
			{"upgrade", "换成新镜像并重建容器", "沿用现有配置不重问；会话、插件、项目文件、密钥全部保留"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["action"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := confirmPage()
			return &p
		},
	}
}

func deleteScopePage() page {
	return page{
		kind:  pageSelect,
		title: "删除的数据范围",
		choices: []choice{
			{"0", "全部删除", "容器、镜像、.env、模型密钥、root 密码哈希，以及 data/ 和 workspace/ 里的一切"},
			{"1", "保留会话、工作目录和插件", "只留 workspace/、data/dsh/sessions/、data/dsh/profiles/；其余照样删干净"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["delete_keep"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := deleteConfirmPage()
			return &p
		},
	}
}

// deleteConfirmPage 是不可逆操作的最终闸门：用选择项而非手输单词。
//
// 早先这一步在 install.sh 里要求手输 DELETE。放进向导后改成显式的两项选择：
// 默认光标停在「取消」，所以回车不会误删；要删除必须主动按 ↑ 移到「确认删除」。
func deleteConfirmPage() page {
	return page{
		kind:  pageConfirm,
		title: "确认删除",
		choices: []choice{
			{"no", "取消", "不执行删除，退出向导"},
			{"yes", "确认删除", "按上面选的范围立即清理，不可恢复"},
		},
		summary: func(m *wizardModel) []string {
			scope := "全部删除"
			if m.answers["delete_keep"] == "1" {
				scope = "保留会话、工作目录和插件"
			}
			return []string{
				"数据范围: " + scope,
				"将删除: dsh 容器、DSH 镜像、本项目 Compose 挂载和网络、全局 Docker 构建缓存",
			}
		},
		apply: func(m *wizardModel, v string) bool {
			if v != "yes" {
				m.aborted = true
				return true
			}
			m.answers["delete_confirmed"] = "yes"
			return true
		},
	}
}

func installModePage() page {
	return page{
		kind:  pageSelect,
		title: "安装方式",
		choices: []choice{
			{"quick", "一键安装", "basic 认证 + 随机账密 + 关闭密钥代理，零提问"},
			{"manual", "手动配置", "逐页选择镜像来源、访问保护、出站策略、模型密钥等"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["mode"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			if m.answers["mode"] == "quick" {
				// 一键安装不再询问任何配置：直接到确认页。
				p := confirmPage()
				return &p
			}
			p := imageSourcePage()
			return &p
		},
	}
}

func imageSourcePage() page {
	return page{
		kind:  pageSelect,
		title: "Debian 13 镜像来源",
		choices: []choice{
			{"prebuilt", "拉取公开预构建镜像", "推荐：不在本机编译 DSH，安装耗时约等于下载耗时"},
			{"build", "在本机构建镜像", "用当前工程 Dockerfile 现场构建，约几分钟"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["image_source"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := accessModePage()
			return &p
		},
	}
}

func accessModePage() page {
	return page{
		kind:  pageSelect,
		title: "访问保护方式",
		choices: []choice{
			{"local", "仅本机或 SSH 隧道", "容器内不做认证，只绑定回环地址"},
			{"trusted-proxy", "已有 Cloudflare Access / 面板认证 / 私有 VPN", "容器内不做认证，完全依赖外层入口"},
			{"basic", "DSH 内置 Nginx Basic Auth", "容器内用 bcrypt 密码文件认证；外层仍须提供 HTTPS"},
			{"password", "多用户（开放注册 + 每实例独立容器）", "认证由内置网关承担，可注册账户、TOTP、通行密钥"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["access"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			switch m.answers["access"] {
			case "trusted-proxy":
				// 这个模式的边界必须让人确认过：容器内没有任何认证，
				// 直连源站 IP 即可绕过外层入口。
				p := trustedProxyAckPage()
				return &p
			case "basic":
				p := basicAuthPage()
				return &p
			case "password":
				p := userModePage()
				return &p
			}
			p := egressPage()
			return &p
		},
	}
}

// trustedProxyAckPage 是 trusted-proxy 模式的风险确认。
//
// 默认光标停在「返回改选」：这个模式的默认结局是「无锁」，不该因为一路回车而选中。
func trustedProxyAckPage() page {
	return page{
		kind:  pageConfirm,
		title: "确认 trusted-proxy 的风险",
		choices: []choice{
			{"back", "返回改选其它模式", "改用 basic 或 local，容器内保留一道认证"},
			{"ack", "我已了解并继续", "外层认证之外另有不依赖 IP/Host 的防护"},
		},
		summary: func(m *wizardModel) []string {
			return []string{
				"容器内不做认证：直连源站 IP 不经过 Cloudflare Access，等于没有锁",
				"源站 IP 通常会被 Shodan / Censys 按证书信息索引，应按「已公开」设计防护",
				"DSH_TRUSTED_HOSTS 只是 cookie 绑定键，不是访问白名单",
				"自检: curl -k -i -H \"Host: <你的域名>\" https://<源站IP>/  返回 200 即为可绕过",
			}
		},
		apply: func(m *wizardModel, v string) bool {
			if v == "ack" {
				m.answers["trusted_proxy_ack"] = "yes"
			}
			return false
		},
		next: func(m *wizardModel) *page {
			if m.answers["trusted_proxy_ack"] != "yes" {
				p := accessModePage()
				return &p
			}
			p := egressPage()
			return &p
		},
	}
}

// basicAuthPage 收集 Basic Auth 用户名与密码。
//
// 用户名与密码分两页，密码页用掩码输入；两页都校验，避免把不合规的值交给
// install.sh 再报一次错（那会把用户困在一次注定失败的安装里）。
func basicAuthPage() page {
	return page{
		kind:        pageInput,
		title:       "Basic Auth 用户名",
		label:       "用户名（字母、数字、点、下划线、连字符）",
		placeholder: "默认 dsh",
		apply: func(m *wizardModel, v string) bool {
			if v == "" {
				v = "dsh"
			}
			m.answers["basic_user"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := basicPasswordPage()
			return &p
		},
	}
}

func basicPasswordPage() page {
	return page{
		kind:  pageSecret,
		title: "Basic Auth 密码",
		label: "密码（至少 12 个字符）",
		validate: func(v string) string {
			if len([]rune(v)) < 12 {
				return "密码至少需要 12 个字符。"
			}
			return ""
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["basic_password"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := egressPage()
			return &p
		},
	}
}

func userModePage() page {
	return page{
		kind:  pageSelect,
		title: "用户模式",
		choices: []choice{
			{"off", "单管理员", "一套管理员凭据，不开放注册"},
			{"on", "多用户", "开放注册；每个账户拥有独立会话与文件（独立 DSH 实例）"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["multi_user"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			if m.answers["multi_user"] == "on" {
				p := registerGatePage()
				return &p
			}
			p := egressPage()
			return &p
		},
	}
}

func registerGatePage() page {
	return page{
		kind:  pageSelect,
		title: "注册门槛",
		choices: []choice{
			{"open", "开放注册", "任何能访问入口的人都可以注册"},
			{"invite", "需要邀请码", "安装结束时会生成一个初始码并显示一次，之后可在管理面板轮换"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["register_gate"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := idleTimeoutPage()
			return &p
		},
	}
}

func idleTimeoutPage() page {
	return page{
		kind:  pageSelect,
		title: "闲置停用阈值",
		choices: []choice{
			{"1800", "30 分钟", "默认；实例无活动超过该时长即停用，内存归零、数据保留"},
			{"900", "15 分钟", "更省内存，用户回来的等待更频繁"},
			{"3600", "60 分钟", "更少唤醒，闲置内存占用更久"},
			{"0", "从不", "实例常驻不回收，内存占用最高"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["idle_timeout"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := diskQuotaPage()
			return &p
		},
	}
}

func diskQuotaPage() page {
	return page{
		kind:  pageSelect,
		title: "每用户磁盘配额",
		choices: []choice{
			{"5", "5GB", "默认"},
			{"2", "2GB", "更省磁盘"},
			{"10", "10GB", "更宽松"},
			{"0", "不限制", "不设上限"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["disk_quota"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := egressPage()
			return &p
		},
	}
}

func egressPage() page {
	return page{
		kind:  pageSelect,
		title: "容器出站网络",
		choices: []choice{
			{"open", "open", "容器直接访问任意外网地址"},
			{"blocklist", "blocklist", "出站经 dsh-egress 代理，默认放行，只挡黑名单里的域名（内置清单挡 cloudflared 快速隧道、ngrok 等）"},
			{"allowlist", "allowlist", "出站经 dsh-egress 代理，只放行白名单里的域名，其余返回 403"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["egress"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			if m.answers["egress"] == "allowlist" {
				p := egressAllowPage()
				return &p
			}
			p := modelBrokerPage()
			return &p
		},
	}
}

// egressAllowPage 收集 allowlist 模式下的额外放行域名。
func egressAllowPage() page {
	return page{
		kind:        pageInput,
		title:       "额外放行的域名",
		label:       "逗号分隔，支持 *.example.com",
		placeholder: "留空表示只用内置白名单（覆盖 Debian、npm、PyPI、GitHub、ghcr.io 等）",
		apply: func(m *wizardModel, v string) bool {
			m.answers["egress_allow"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := modelBrokerPage()
			return &p
		},
	}
}

func modelBrokerPage() page {
	return page{
		kind:  pageSelect,
		title: "模型密钥代理",
		choices: []choice{
			{"on", "开启", "真实密钥只存宿主机与独立容器里；Agent 容器只拿到占位密钥"},
			{"off", "关闭", "密钥直接写进 DSH 配置，失去这一层保护"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["model_broker"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			if m.answers["model_broker"] == "on" {
				p := keyAdminPage()
				return &p
			}
			p := proxyLocationPage()
			return &p
		},
	}
}

func keyAdminPage() page {
	return page{
		kind:  pageSelect,
		title: "模型密钥管理面板",
		choices: []choice{
			{"on", "开启", "浏览器里填密钥、拉模型列表；独立容器，dsh 容器连不到它"},
			{"off", "关闭", "只在终端里填密钥"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["key_admin"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := proxyLocationPage()
			return &p
		},
	}
}

func proxyLocationPage() page {
	return page{
		kind:  pageSelect,
		title: "反向代理位置",
		choices: []choice{
			{"host", "宿主机", "用宿主机的 Nginx 或 SSH 隧道反代，上游写 http://127.0.0.1:3080"},
			{"docker", "Docker 容器 / 面板", "DSH 加入一个外部网络，反向代理用 http://dsh:3080 访问它"},
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["proxy"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			if m.answers["proxy"] == "docker" {
				p := proxyNetworkPage()
				return &p
			}
			p := bindHostPage()
			return &p
		},
	}
}

// proxyNetworkPage 收集反向代理所在的 Docker 网络名。
//
// 这一步在 bash 版里是「列出宿主机现有网络再让人选」，需要访问 Docker。向导不碰
// Docker（它只收集答案），所以改成文本输入并给出默认值：dsh-proxy。
// install.sh 收到这个名字后会自己检查网络是否存在，不存在时创建。
func proxyNetworkPage() page {
	return page{
		kind:        pageInput,
		title:       "反向代理所在的 Docker 网络",
		label:       "网络名",
		placeholder: "默认 dsh-proxy（不存在时由安装器创建）",
		apply: func(m *wizardModel, v string) bool {
			if v == "" {
				v = "dsh-proxy"
			}
			m.answers["proxy_network"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := bindHostPage()
			return &p
		},
	}
}

func bindHostPage() page {
	return page{
		kind:        pageInput,
		title:       "端口绑定地址",
		label:       "宿主机端口绑定地址",
		placeholder: "默认 127.0.0.1（推荐；公网访问必须经 HTTPS 与认证入口）",
		apply: func(m *wizardModel, v string) bool {
			if v == "" {
				v = "127.0.0.1"
			}
			m.answers["bind_host"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := rootPasswordChoicePage()
			return &p
		},
	}
}

func rootPasswordChoicePage() page {
	return page{
		kind:  pageSelect,
		title: "容器 root 密码",
		choices: []choice{
			{"set", "现在设置", "容器内执行特权命令需要它；apt 与 DSH 更新不受影响"},
			{"no", "不设置", "关闭这条提权路径，容器内无法执行任意特权命令"},
		},
		apply: func(m *wizardModel, v string) bool {
			if v == "no" {
				m.answers["no_root_password"] = "yes"
			}
			return false
		},
		next: func(m *wizardModel) *page {
			if m.answers["no_root_password"] == "yes" {
				p := confirmPage()
				return &p
			}
			p := rootPasswordPage()
			return &p
		},
	}
}

// rootPasswordPage 收集容器 root 密码。
//
// 长度下限与 install.sh 的校验一致（12 字符）：两边不一致时向导会「看起来通过」
// 而脚本再报错，把用户困在一次注定失败的安装里。
func rootPasswordPage() page {
	return page{
		kind:  pageSecret,
		title: "设置容器 root 密码",
		label: "密码（至少 12 个字符）",
		validate: func(v string) string {
			if len([]rune(v)) < 12 {
				return "密码至少需要 12 个字符。"
			}
			return ""
		},
		apply: func(m *wizardModel, v string) bool {
			m.answers["root_password"] = v
			return false
		},
		next: func(m *wizardModel) *page {
			p := confirmPage()
			return &p
		},
	}
}

func confirmPage() page {
	return page{
		kind:  pageConfirm,
		title: "确认是否执行",
		choices: []choice{
			{"yes", "是", "执行当前操作"},
			{"no", "否", "不执行，返回上一步"},
		},
		summary: func(m *wizardModel) []string {
			return m.summaryLines()
		},
		apply: func(m *wizardModel, v string) bool {
			if v != "yes" {
				m.aborted = true
				return true
			}
			return true
		},
	}
}
