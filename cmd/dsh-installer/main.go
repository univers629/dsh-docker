// Package main 实现 DSH 安装向导的终端界面。
//
// 分层与 dpanel 的安装器一致：引导脚本负责探测与下载，界面由一个 Go 二进制承载，
// 界面使用与 dpanel 相同的 TUI 框架（Bubble Tea + Lipgloss）。
//
// 职责边界：本程序只负责问问题并把答案输出到标准输出，安装逻辑仍由 install.sh 执行。
// 这样 curl | bash 这种脚本没有文件路径的场景也能用——界面进程不回调脚本，只回传答案。
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// version 由构建时注入：-ldflags "-X main.version=..."
var version = "dev"

const usageText = `用法：dsh-installer [选项]

不带选项时打开分页向导，逐页收集安装配置；确认后界面原地切到执行视图，
在页面内滚动显示安装日志。全程只进出一次备用屏幕。

选项：
  --answers-file PATH     把答案写到该文件（默认 stdout）
  --dir PATH              工程目录（默认 ./dsh-docker）
  --run-gate PATH         向导确认后打开该 FIFO 放行后台执行子 shell
  --dry-run               打印将执行的 install.sh 命令，不写答案（调试用）
  --menu                  只显示主菜单第一页（调试用）
  --watch-log PATH        执行视图读取的日志文件
  --watch-title TEXT      执行视图的标题
  --watch-sentinel TEXT   结束标记前缀（形如 __DSH_EXEC_DONE__，后面跟退出码）
  --watch-summary-file PATH  执行结束后读取的关键信息文件
  -h, --help              显示本帮助
  -v, --version           显示版本
`

// exitCancelled 表示用户主动取消（Ctrl+C 或确认页答「否」）。
// 与出错分开：取消不该让调用方打印错误信息，也不该返回非零错误码。
const exitCancelled = 3

func main() {
	opts, err := parseArgs(os.Args[1:])
	if err != nil {
		switch {
		case errors.Is(err, errHelp):
			fmt.Print(usageText)
			os.Exit(0)
		case errors.Is(err, errVersion):
			fmt.Println("dsh-installer " + version)
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, "[错误] "+err.Error())
		os.Exit(2)
	}

	// WithAltScreen：向导与执行视图共用一个 tea.Program，整场安装只进出一次备用屏幕。
	// 分两次调用做不到——第一次退出必然还原备用屏幕，第二次再进入就是两进两出，
	// 中间那段输出还会漏到备用屏幕之外的终端行里。
	program := tea.NewProgram(newRootModel(opts), tea.WithAltScreen())

	final, err := program.Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[错误] 界面初始化失败："+err.Error())
		os.Exit(1)
	}
	result, ok := final.(rootModel)
	if !ok {
		fmt.Fprintln(os.Stderr, "[错误] 界面状态异常。")
		os.Exit(1)
	}

	// --dry-run 只在调试时用：把将要执行的命令打出来就结束，不碰答案文件、不放行执行体。
	if opts.dryRun {
		fmt.Println(strings.Join(append([]string{"install.sh"}, result.wizard.commandArgs()...), " "))
		os.Exit(0)
	}

	if result.err != nil {
		fmt.Fprintln(os.Stderr, "[错误] "+result.err.Error())
		os.Exit(1)
	}

	// 退出备用屏幕之后，整屏已经还原。这里只补一句日志路径——摘要、访问地址、
	// 失败原因都由执行视图在页面里展示过了，再打一遍既重复又已经滚过去。
	if result.quitMsg != "" {
		fmt.Fprintln(os.Stderr, result.quitMsg)
	}

	if result.code != 0 {
		os.Exit(result.code)
	}
}

// emitAnswers 输出 KEY=VALUE，按 key 排序保证可重复。
// 值里可能含空格等字符，调用方按行读取 KEY=VALUE 的右侧整体即可，无需再做引号解析。
func emitAnswers(w io.Writer, answers map[string]string) {
	keys := make([]string, 0, len(answers))
	for k := range answers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(w, "%s=%s\n", k, answers[k])
	}
}

var (
	errHelp    = errors.New("help")
	errVersion = errors.New("version")
)

type options struct {
	dir         string
	answersFile string
	dryRun      bool
	menuOnly    bool

	// runGate 是 FIFO 路径。向导确认后打开它的写端即可放行后台执行子 shell，
	// 那个子 shell 正阻塞在同一 FIFO 的读端上。用 FIFO 而不是信号或轮询：
	// 它是内核里的同步点，天然保证「答案落盘」先于「执行开始」。
	runGate string

	// 执行阶段（与向导共用同一个 tea.Program）
	watchLog         string
	watchTitle       string
	watchSentinel    string
	watchSummary     []string
	watchSummaryFile string
}

func parseArgs(argv []string) (options, error) {
	opts := options{dir: "dsh-docker", watchSentinel: "__DSH_EXEC_DONE__"}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		// next 取出该选项的值；缺值时由调用方报错。
		next := func() (string, bool) {
			if i+1 >= len(argv) {
				return "", false
			}
			i++
			return argv[i], true
		}
		switch {
		case arg == "-h" || arg == "--help":
			return opts, errHelp
		case arg == "-v" || arg == "--version":
			return opts, errVersion
		case arg == "--dry-run":
			opts.dryRun = true
		case arg == "--menu":
			opts.menuOnly = true
		case arg == "--dir":
			v, ok := next()
			if !ok {
				return opts, errors.New("--dir 缺少值")
			}
			opts.dir = v
		case strings.HasPrefix(arg, "--dir="):
			opts.dir = strings.TrimPrefix(arg, "--dir=")
		case arg == "--answers-file":
			v, ok := next()
			if !ok {
				return opts, errors.New("--answers-file 缺少值")
			}
			opts.answersFile = v
		case strings.HasPrefix(arg, "--answers-file="):
			opts.answersFile = strings.TrimPrefix(arg, "--answers-file=")
		case arg == "--run-gate":
			v, ok := next()
			if !ok {
				return opts, errors.New("--run-gate 缺少值")
			}
			opts.runGate = v
		case strings.HasPrefix(arg, "--run-gate="):
			opts.runGate = strings.TrimPrefix(arg, "--run-gate=")
		case arg == "--watch-log":
			v, ok := next()
			if !ok {
				return opts, errors.New("--watch-log 缺少值")
			}
			opts.watchLog = v
		case strings.HasPrefix(arg, "--watch-log="):
			opts.watchLog = strings.TrimPrefix(arg, "--watch-log=")
		case arg == "--watch-title":
			v, ok := next()
			if !ok {
				return opts, errors.New("--watch-title 缺少值")
			}
			opts.watchTitle = v
		case arg == "--watch-sentinel":
			v, ok := next()
			if !ok {
				return opts, errors.New("--watch-sentinel 缺少值")
			}
			opts.watchSentinel = v
		case arg == "--watch-summary":
			v, ok := next()
			if !ok {
				return opts, errors.New("--watch-summary 缺少值")
			}
			opts.watchSummary = append(opts.watchSummary, v)
		case arg == "--watch-summary-file":
			v, ok := next()
			if !ok {
				return opts, errors.New("--watch-summary-file 缺少值")
			}
			opts.watchSummaryFile = v
		default:
			return opts, fmt.Errorf("未知参数：%s", arg)
		}
	}
	return opts, nil
}

// itoa 供页面构造参数时使用。
func itoa(n int) string { return fmt.Sprintf("%d", n) }
