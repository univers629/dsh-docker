package main

// 执行阶段的 TUI 视图：在固定区域内滚动显示安装日志，底部是可选的操作项。
//
// 为什么需要它：安装的执行阶段要几分钟（拉镜像、建容器、跑自检），这期间如果只是
// 把日志直接打到终端，用户看到的是长时间滚动的输出，看不出"跑到哪了、还要多久、
// 成功没有"；而且关键信息（访问地址、密钥面板令牌）会被后续输出顶走，装完就找不到了。
//
// 这里把执行阶段放进一个固定框架：上方是自动跟随的日志区，下方是状态与操作项。
// 日志来源是一个文件（install.sh 把执行阶段的输出重定向进去），而不是管道——
// 文件让视图可以在执行结束后继续回看，也不占用管道的退出码语义。

import (
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"
)

// execViewOptions 由命令行传入。
type execViewOptions struct {
	logPath   string   // 执行日志文件
	sentinel  string   // 结束标记前缀，形如 "__DSH_EXEC_DONE__:<退出码>"
	title     string   // 标题栏文字
	summary   []string // 完成后显示的关键信息（命令行给定）
	keepLines int      // 内存里保留的最大行数

	// summaryPath 指向一个文件，执行结束时由 install.sh 写入关键信息
	//（访问地址、密钥面板令牌等）。这些值只有跑完才知道，无法作为命令行参数
	// 提前给出；写在文件里还能让摘要区与日志区分开——日志会滚动，摘要不会。
	summaryPath string
}

type execViewModel struct {
	opts execViewOptions

	lines  []string
	offset int64
	// pendingLine 保存尚未以换行结束的最后一段：日志是按块读的，一段可能被切成
	// 两个块，不缓存的话每一块都会被当成一整行，画面里出现半截重复。
	pendingLine string
	done        bool
	code        int
	// doneSummary 是执行结束后从 summaryPath 读到的关键信息。
	doneSummary []string

	width, height int
	// follow 为真时日志区自动贴底显示最新输出；用户上翻时关闭。
	follow bool
	scroll int
	// cursor 是完成后的操作项下标。
	cursor int
	// quitMsg 是退出后要打印到终端的内容（例如日志路径），由调用方决定。
	quitMsg string
	err     error
}

const execViewMaxLines = 5000

func newExecViewModel(opts execViewOptions) execViewModel {
	if opts.keepLines <= 0 {
		opts.keepLines = execViewMaxLines
	}
	if opts.title == "" {
		opts.title = "正在执行"
	}
	return execViewModel{opts: opts, follow: true}
}

// execTickMsg 触发一次日志增量读取。
type execTickMsg struct{}

func (m execViewModel) Init() tea.Cmd {
	if m.opts.logPath == "" {
		return tea.Quit
	}
	return tea.Tick(150*time.Millisecond, func(time.Time) tea.Msg { return execTickMsg{} })
}

func (m execViewModel) readMore() execViewModel {
	if m.opts.logPath == "" {
		return m
	}
	f, err := os.Open(m.opts.logPath)
	if err != nil {
		// 文件还没被创建：不是错误，下一个 tick 再试。
		return m
	}
	defer f.Close()

	if _, err := f.Seek(m.offset, 0); err != nil {
		return m
	}
	buf := make([]byte, 1<<16)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			m.offset += int64(n)
			chunk := string(buf[:n])
			// 按行切分，保留最后一段不完整的行等待下次读取。
			parts := strings.Split(chunk, "\n")
			if len(parts) > 0 {
				// 上一段未完成的行与本段第一片拼接
				if m.pendingLine != "" {
					parts[0] = m.pendingLine + parts[0]
					m.pendingLine = ""
				}
				m.pendingLine = parts[len(parts)-1]
				for _, line := range parts[:len(parts)-1] {
					m.lines = append(m.lines, stripANSI(line))
				}
			}
			// 结束标记：出现在日志流里即表示执行阶段已结束
			for _, line := range parts[:len(parts)-1] {
				plain := stripANSI(line)
				if strings.HasPrefix(plain, m.opts.sentinel+":") {
					codeStr := strings.TrimPrefix(plain, m.opts.sentinel+":")
					m.done = true
					m.code = 0
					fmt.Sscanf(codeStr, "%d", &m.code)
					// 标记行本身不是给用户看的
					m.lines = m.lines[:len(m.lines)-1]
				}
			}
			if len(m.lines) > m.opts.keepLines {
				drop := len(m.lines) - m.opts.keepLines
				m.lines = append([]string(nil), m.lines[drop:]...)
				m.scroll -= drop
				if m.scroll < 0 {
					m.scroll = 0
				}
			}
		}
		if err != nil {
			break
		}
	}
	if m.done {
		m.follow = true
		// 结束时读取 install.sh 写下的摘要：这些值（访问地址、令牌）只有跑完才知道。
		if m.opts.summaryPath != "" {
			if data, err := os.ReadFile(m.opts.summaryPath); err == nil {
				for _, line := range strings.Split(string(data), "\n") {
					if s := strings.TrimSpace(stripANSI(line)); s != "" {
						m.doneSummary = append(m.doneSummary, s)
					}
				}
			}
		}
	}
	return m
}

// allSummary 合并命令行给定与文件写下的摘要，文件内容在后（它更具体）。
func (m execViewModel) allSummary() []string {
	out := append([]string(nil), m.opts.summary...)
	return append(out, m.doneSummary...)
}

func (m execViewModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case execTickMsg:
		m = m.readMore()
		if m.done {
			return m, nil // 停止轮询
		}
		return m, tea.Tick(150*time.Millisecond, func(time.Time) tea.Msg { return execTickMsg{} })

	case tea.KeyMsg:
		// 完成前只允许滚动与中断，完成后再提供操作项。
		switch msg.Type {
		case tea.KeyCtrlC:
			m.quitMsg = "已中断显示；安装进程可能仍在后台运行。"
			return m, tea.Quit
		case tea.KeyUp:
			if m.done {
				if m.cursor > 0 {
					m.cursor--
				}
				return m, nil
			}
			m.follow = false
			if m.scroll > 0 {
				m.scroll--
			}
			return m, nil
		case tea.KeyDown:
			if m.done {
				if m.cursor < len(m.doneOptions())-1 {
					m.cursor++
				}
				return m, nil
			}
			m.follow = false
			m.scroll++
			return m, nil
		case tea.KeyPgUp:
			m.follow = false
			m.scroll -= m.logHeight() / 2
			if m.scroll < 0 {
				m.scroll = 0
			}
			return m, nil
		case tea.KeyPgDown:
			m.scroll += m.logHeight() / 2
			return m, nil
		case tea.KeyEnd:
			m.follow = true
			return m, nil
		case tea.KeyHome:
			m.follow = false
			m.scroll = 0
			return m, nil
		case tea.KeyEnter:
			if m.done {
				return m.applyOption()
			}
			return m, nil
		}
	}
	return m, nil
}

func (m execViewModel) doneOptions() []string {
	return []string{"退出", "显示日志文件路径"}
}

func (m execViewModel) applyOption() (tea.Model, tea.Cmd) {
	switch m.cursor {
	case 0:
		return m, tea.Quit
	case 1:
		m.quitMsg = "完整日志： " + m.opts.logPath
		return m, tea.Quit
	}
	return m, nil
}

// logHeight 是日志区可用的行数：总高度减去标题、状态、操作区与留白。
func (m execViewModel) logHeight() int {
	h := m.height - 6
	if m.done {
		h -= len(m.allSummary()) + 2
	}
	if h < 3 {
		h = 3
	}
	return h
}

func (m execViewModel) View() string {
	if m.width == 0 {
		return ""
	}
	var b strings.Builder

	// 标题栏
	state := "进行中"
	if m.done {
		if m.code == 0 {
			state = "已完成"
		} else {
			state = fmt.Sprintf("失败（退出码 %d）", m.code)
		}
	}
	head := titleStyle.Render("DeepSeek Harness")
	head += subtitleStyle.Render(" - " + m.opts.title + " ")
	head += cursorStyle.Render("[" + state + "]")
	b.WriteString(head + "\n\n")

	// 日志区：固定高度，超出的部分按 scroll/follow 截取
	lh := m.logHeight()
	start := 0
	if m.follow {
		if len(m.lines) > lh {
			start = len(m.lines) - lh
		}
	} else {
		start = m.scroll
		if start > len(m.lines)-lh {
			start = len(m.lines) - lh
		}
		if start < 0 {
			start = 0
		}
	}
	end := start + lh
	if end > len(m.lines) {
		end = len(m.lines)
	}
	for i := start; i < end; i++ {
		b.WriteString(truncateWidth(m.lines[i], m.width-2) + "\n")
	}
	// 补空行，保持框高稳定（否则内容少时下方的操作项会跳动）
	for i := end - start; i < lh; i++ {
		b.WriteString("\n")
	}

	if m.done {
		b.WriteString("\n")
		for _, line := range m.allSummary() {
			b.WriteString(descStyle.Render("  "+truncateWidth(line, m.width-4)) + "\n")
		}
		b.WriteString("\n")
		for i, opt := range m.doneOptions() {
			if i == m.cursor {
				b.WriteString(cursorStyle.Render("  ▸ "+opt) + "\n")
			} else {
				b.WriteString(choiceStyle.Render("    "+opt) + "\n")
			}
		}
	}

	if m.err != nil {
		b.WriteString("\n" + errStyle.Render("  "+m.err.Error()) + "\n")
	}

	hint := "  ↑/↓ 滚动 | PgUp/PgDn 翻页 | End 回到最新"
	if m.done {
		hint = "  ↑/↓ 选择 | Enter 确认"
	}
	b.WriteString("\n" + helpStyle.Render(hint) + "\n")

	return b.String()
}

// truncateWidth 按显示宽度截断（CJK 占两列），并加省略号。
// 直接按字节或 rune 截断会让含中文的日志行把边框撑歪。
func truncateWidth(s string, max int) string {
	if max <= 1 {
		return ""
	}
	if runewidth.StringWidth(s) <= max {
		return s
	}
	out := make([]rune, 0, len(s))
	w := 0
	for _, r := range s {
		rw := runewidth.RuneWidth(r)
		if w+rw > max-1 {
			break
		}
		out = append(out, r)
		w += rw
	}
	return string(out) + "…"
}

// stripANSI 去掉 ANSI 转义序列：日志里可能带颜色，直接按宽度排版会算错。
func stripANSI(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == 0x1b && i+1 < len(s) {
			j := i + 1
			if s[j] == '[' {
				j++
				for j < len(s) && !(s[j] >= 0x40 && s[j] <= 0x7e) {
					j++
				}
				i = j
				continue
			}
			if s[j] == ']' {
				j++
				for j < len(s) && s[j] != 0x07 && !(s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\') {
					j++
				}
				i = j + 1
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

var _ = lipgloss.NewStyle // 保持导入（样式在 wizard.go 中定义）
