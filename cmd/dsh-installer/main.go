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

不带选项时打开分页向导，逐页收集安装配置。答案写到 --answers-file 指定的文件
（默认 stdout），每行一个 KEY=VALUE；install.sh 读入后继续执行安装。

界面占用终端的备用屏幕，答案写文件而不是 stdout，两者互不干扰。

选项：
  --answers-file PATH   把答案写到该文件（默认 stdout）
  --dir PATH            工程目录（默认 ./dsh-docker）
  --dry-run             打印将执行的 install.sh 命令，不写答案（调试用）
  --menu                只显示主菜单第一页（调试用）
  -h, --help            显示本帮助
  -v, --version         显示版本
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

	// WithAltScreen：整个向导占用备用屏幕缓冲，退出后终端恢复原样。
	// 这是 dpanel 安装器的行为：界面不会滚进 scrollback。
	program := tea.NewProgram(newWizard(opts), tea.WithAltScreen())

	final, err := program.Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[错误] 界面初始化失败："+err.Error())
		os.Exit(1)
	}
	result, ok := final.(wizardModel)
	if !ok {
		fmt.Fprintln(os.Stderr, "[错误] 界面状态异常。")
		os.Exit(1)
	}
	if result.aborted {
		fmt.Fprintln(os.Stderr, "已取消，未做任何改动。")
		os.Exit(exitCancelled)
	}

	answers := result.answers
	if answers["action"] == "" {
		fmt.Fprintln(os.Stderr, "已取消，未做任何改动。")
		os.Exit(exitCancelled)
	}

	if opts.dryRun {
		args := result.commandArgs()
		fmt.Println(strings.Join(append([]string{"install.sh"}, args...), " "))
		os.Exit(0)
	}

	// 答案写文件而不是 stdout：界面占用备用屏幕，两者分开可避免互相干扰，
	// 也让 install.sh 能在向导退出、终端复原之后再把文件读回来。
	out := os.Stdout
	if opts.answersFile != "" {
		file, err := os.Create(opts.answersFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "[错误] 无法写入答案文件："+err.Error())
			os.Exit(1)
		}
		defer file.Close()
		out = file
	}
	emitAnswers(out, answers)
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
}

func parseArgs(argv []string) (options, error) {
	opts := options{dir: "dsh-docker"}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
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
			if i+1 >= len(argv) {
				return opts, errors.New("--dir 缺少值")
			}
			i++
			opts.dir = argv[i]
		case strings.HasPrefix(arg, "--dir="):
			opts.dir = strings.TrimPrefix(arg, "--dir=")
		case arg == "--answers-file":
			if i+1 >= len(argv) {
				return opts, errors.New("--answers-file 缺少值")
			}
			i++
			opts.answersFile = argv[i]
		case strings.HasPrefix(arg, "--answers-file="):
			opts.answersFile = strings.TrimPrefix(arg, "--answers-file=")
		default:
			return opts, fmt.Errorf("未知参数：%s", arg)
		}
	}
	return opts, nil
}

// itoa 供页面构造参数时使用。
func itoa(n int) string { return fmt.Sprintf("%d", n) }
