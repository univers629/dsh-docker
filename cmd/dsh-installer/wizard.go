package main

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// 配色：DSH 品牌蓝（#4D6BFE）作强调色，其余用终端默认色，
// 使界面在浅色与深色终端下都可读。
var (
	brandBlue = lipgloss.Color("#4D6BFE")

	titleStyle    = lipgloss.NewStyle().Bold(true).Foreground(brandBlue)
	subtitleStyle = lipgloss.NewStyle().Faint(true)
	cursorStyle   = lipgloss.NewStyle().Bold(true).Foreground(brandBlue)
	choiceStyle   = lipgloss.NewStyle()
	descStyle     = lipgloss.NewStyle().Faint(true)
	helpStyle     = lipgloss.NewStyle().Faint(true)
	errStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	// 横幅用品牌蓝实心渲染，与 install.sh 的 truecolor 输出一致。
	bannerColor = lipgloss.NewStyle().Foreground(brandBlue)
)

// choice 是一个可选项：value 用于回传给 install.sh，label/desc 用于显示。
type choice struct {
	value string
	label string
	desc  string
}

type pageKind int

const (
	pageSelect pageKind = iota
	pageInput
	pageSecret
	pageConfirm
)

// page 是一页。
//
// 页面用「状态机 + 历史栈」而不是预先生成的线性数组来表达：安装向导的后续页面
// 取决于当前答案（选「一键安装」就不该再问镜像来源、访问保护等），预生成数组在
// 遇到分支时要么丢弃后续页、要么把不该问的页也问一遍。历史栈同时天然支持 Esc 回退。
type page struct {
	kind        pageKind
	title       string
	label       string
	placeholder string
	choices     []choice

	// validate 在提交前校验；返回非空字符串表示不通过，用户留在本页。
	validate func(value string) string
	// apply 记录答案。返回 true 表示向导到此结束。
	apply func(m *wizardModel, value string) bool
	// next 返回下一页；返回 nil 表示向导结束。
	next func(m *wizardModel) *page
	// summary 仅确认页使用：生成摘要行。
	summary func(m *wizardModel) []string
}

type wizardModel struct {
	current page
	history []page

	cursor int
	input  string
	err    string

	// width/height 来自 WindowSizeMsg，用于决定横幅是否画得下以及文本是否折行。
	width  int
	height int

	answers map[string]string
	dir     string

	aborted bool
	done    bool
}

func newWizard(opts options) wizardModel {
	m := wizardModel{
		answers: map[string]string{},
		dir:     opts.dir,
		width:   80,
		height:  24,
	}
	m.current = actionPage()
	return m
}

func (m wizardModel) Init() tea.Cmd { return nil }

func (m wizardModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		// 终端尺寸决定横幅是否画得下与文本是否折行，必须记住。
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			m.aborted = true
			return m, tea.Quit
		case tea.KeyEsc:
			return m.goBack(), nil
		case tea.KeyUp:
			if m.current.kind == pageSelect && m.cursor > 0 {
				m.cursor--
			}
			return m, nil
		case tea.KeyDown:
			if n := len(m.current.choices); n > 0 && m.cursor < n-1 {
				m.cursor++
			}
			return m, nil
		case tea.KeyEnter:
			return m.submit()
		case tea.KeyBackspace:
			if m.current.kind == pageInput || m.current.kind == pageSecret {
				if len(m.input) > 0 {
					m.input = m.input[:len(m.input)-1]
				}
			}
			return m, nil
		case tea.KeyRunes:
			if m.current.kind == pageInput || m.current.kind == pageSecret {
				m.input += string(msg.Runes)
			}
			return m, nil
		case tea.KeySpace:
			if m.current.kind == pageInput || m.current.kind == pageSecret {
				m.input += " "
			}
			return m, nil
		}
	}
	return m, nil
}

// value 取出当前页的提交值。
func (m wizardModel) value() string {
	switch m.current.kind {
	case pageSelect, pageConfirm:
		if len(m.current.choices) == 0 {
			return ""
		}
		return m.current.choices[m.cursor].value
	default:
		return strings.TrimSpace(m.input)
	}
}

func (m wizardModel) submit() (tea.Model, tea.Cmd) {
	m.err = ""
	value := m.value()

	if m.current.validate != nil {
		if msg := m.current.validate(value); msg != "" {
			m.err = msg
			return m, nil
		}
	}

	stop := false
	if m.current.apply != nil {
		stop = m.current.apply(&m, value)
	}
	if m.aborted {
		return m, tea.Quit
	}
	if stop {
		m.done = true
		return m, tea.Quit
	}

	var next *page
	if m.current.next != nil {
		next = m.current.next(&m)
	}
	if next == nil {
		m.done = true
		return m, tea.Quit
	}
	m.history = append(m.history, m.current)
	m.current = *next
	m.cursor = 0
	m.input = ""
	return m, nil
}

// goBack 回到上一页，并撤销该页写入的答案：否则「退回改选」之后旧答案仍留在
// 结果里，用户看到的是自己改过的选项，传给 install.sh 的却是改之前的。
func (m wizardModel) goBack() wizardModel {
	if len(m.history) == 0 {
		return m
	}
	m.current = m.history[len(m.history)-1]
	m.history = m.history[:len(m.history)-1]
	m.cursor = 0
	m.input = ""
	m.err = ""
	return m
}

// bodyLineCount 估算本页正文占多少行（含选中项说明与底部提示），
// 供 View 判断横幅还有多少空间可用。必须与 View 的渲染保持一致：
// 少算会让横幅挤掉选项，多算会让横幅该出现时没出现。
func (m wizardModel) bodyLineCount() int {
	lines := 2 // 页头后的空行 + 底部的空行
	switch m.current.kind {
	case pageSelect:
		// 每项一行；只有选中项额外占一行说明。
		lines += len(m.current.choices)
		if m.cursor < len(m.current.choices) && m.current.choices[m.cursor].desc != "" {
			lines++
		}
	case pageInput, pageSecret:
		lines += 2 // 字段名 + 输入行
		if m.input == "" && m.current.placeholder != "" {
			lines++
		}
	case pageConfirm:
		if m.current.summary != nil {
			lines += len(m.current.summary(&m))
		}
		lines += len(m.current.choices)
	}
	if m.err != "" {
		lines += 2
	}
	lines++ // 操作键提示
	return lines
}

func (m wizardModel) View() string {
	if m.done || m.aborted {
		return ""
	}
	var b strings.Builder

	// 横幅：与 install.sh 同一份图案（本文件同目录的 banner.go）。
	// 按剩余行数决定是否画——选项可见优先于图案，行数不够时只显示内容。
	// 正文行数先估出来，横幅才知道自己有多少空间。
	bodyLines := m.bodyLineCount()
	room := 0
	if m.height > 0 {
		// 留一行给底部提示，避免写满最后一行触发终端滚动（滚动会让整页错位）。
		room = m.height - 1 - bodyLines - 1
	}
	if art := bannerLines(m.width, room); art != nil {
		for _, line := range art {
			b.WriteString(bannerColor.Render(line) + "\n")
		}
		b.WriteString("\n")
	}

	// 页头与 install.sh 的向导同版式：`DeepSeek Harness - <页标题> (<页码>)`。
	head := titleStyle.Render("DeepSeek Harness")
	if m.current.title != "" {
		head += subtitleStyle.Render(" - ") + titleStyle.Render(m.current.title)
	}
	head += subtitleStyle.Render(" (" + itoa(len(m.history)+1) + ")")
	b.WriteString(head + "\n\n")

	switch m.current.kind {
	case pageSelect:
		// 只显示选中项的说明：十项各带一行说明会把正文撑到 20 行，
		// 在 24 行终端里直接吃掉横幅与页头的位置。dpanel 的主菜单同样只有动作名。
		for i, c := range m.current.choices {
			if i == m.cursor {
				b.WriteString(cursorStyle.Render("  ▸ "+c.label) + "\n")
				if c.desc != "" {
					b.WriteString(descStyle.Render("      "+c.desc) + "\n")
				}
			} else {
				b.WriteString(choiceStyle.Render("    "+c.label) + "\n")
			}
		}
	case pageInput, pageSecret:
		b.WriteString(choiceStyle.Render("  "+m.current.label) + "\n")
		shown := m.input
		if m.current.kind == pageSecret {
			shown = strings.Repeat("*", len([]rune(m.input)))
		}
		if shown == "" && m.current.placeholder != "" {
			b.WriteString(descStyle.Render("  "+m.current.placeholder) + "\n")
		}
		b.WriteString(cursorStyle.Render("  ▸ ") + shown + "\n")
	case pageConfirm:
		if m.current.summary != nil {
			for _, line := range m.current.summary(&m) {
				b.WriteString(descStyle.Render("  "+line) + "\n")
			}
			b.WriteString("\n")
		}
		for i, c := range m.current.choices {
			label := c.label
			if c.desc != "" {
				label += " - " + c.desc
			}
			if i == m.cursor {
				b.WriteString(cursorStyle.Render("  ▸ "+label) + "\n")
			} else {
				b.WriteString(choiceStyle.Render("    "+label) + "\n")
			}
		}
	}

	if m.err != "" {
		b.WriteString("\n" + errStyle.Render("  "+m.err) + "\n")
	}

	hint := "  ↑/↓ 选择 | Enter 确认"
	if len(m.history) > 0 {
		hint += " | Esc 返回"
	}
	hint += " | Ctrl+C 退出"
	b.WriteString("\n" + helpStyle.Render(hint) + "\n")

	return b.String()
}

// commandArgs 把收集到的答案转换成 install.sh 的命令行参数（供 --dry-run 查看）。
func (m wizardModel) commandArgs() []string {
	action := m.answers["action"]
	if action == "" {
		return nil
	}
	args := []string{action}
	if m.dir != "" {
		args = append(args, "--dir", m.dir)
	}
	if action != "install" && action != "configure" {
		return args
	}
	if m.answers["mode"] == "quick" {
		return append(args, "--quick")
	}
	for _, pair := range [][2]string{
		{"access", "--access"},
		{"image_source", "--image-source"},
		{"bind_host", "--bind-host"},
		{"egress", "--egress"},
		{"multi_user", "--multi-user"},
		{"register_gate", "--register-gate"},
		{"idle_timeout", "--idle-timeout"},
		{"disk_quota", "--user-disk-quota"},
		{"key_admin", "--key-admin"},
	} {
		if v := m.answers[pair[0]]; v != "" {
			args = append(args, pair[1], v)
		}
	}
	if m.answers["model_broker"] == "on" {
		args = append(args, "--model-broker")
	}
	if m.answers["no_root_password"] == "yes" {
		args = append(args, "--no-root-password")
	}
	if pw := m.answers["root_password"]; pw != "" {
		args = append(args, "--root-password", pw)
	}
	return args
}

// summaryLines 生成确认页的摘要。摘要取自已收集的答案而不是静态文本：
// 分支页会改写答案，静态摘要会把改动过的值显示成旧值。
func (m wizardModel) summaryLines() []string {
	label := map[string]string{
		"install": "安装", "configure": "重新配置", "update": "更新", "upgrade": "换新镜像重建",
		"start": "启动", "stop": "停止", "restart": "重启",
		"logs": "查看日志", "status": "查看状态", "delete": "卸载",
		"model-key": "补填模型密钥", "key-panel": "密钥管理面板",
	}
	lines := []string{
		"操作: " + label[m.answers["action"]],
		"工程目录: " + m.dir,
	}
	action := m.answers["action"]
	if action != "install" && action != "configure" {
		if action == "delete" {
			scope := "全部删除"
			if m.answers["delete_keep"] == "1" {
				scope = "保留会话、工作目录和插件"
			}
			lines = append(lines, "数据范围: "+scope)
		}
		return lines
	}
	if m.answers["mode"] == "quick" {
		return append(lines, "安装方式: 一键安装（basic 认证 + 随机账密 + 关闭密钥代理）")
	}
	for _, pair := range [][2]string{
		{"image_source", "镜像来源"},
		{"access", "访问保护"},
		{"multi_user", "用户模式"},
		{"register_gate", "注册门槛"},
		{"idle_timeout", "闲置阈值(秒)"},
		{"disk_quota", "磁盘配额(GB)"},
		{"egress", "出站模式"},
		{"model_broker", "模型密钥代理"},
		{"key_admin", "密钥管理面板"},
		{"bind_host", "绑定地址"},
	} {
		if v := m.answers[pair[0]]; v != "" {
			lines = append(lines, fmt.Sprintf("%s: %s", pair[1], v))
		}
	}
	if m.answers["no_root_password"] == "yes" {
		lines = append(lines, "容器 root 密码: 不设置")
	} else if m.answers["root_password"] != "" {
		lines = append(lines, "容器 root 密码: 已设置")
	}
	return lines
}
