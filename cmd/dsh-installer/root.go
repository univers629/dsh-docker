package main

// 安装会话的根模型：向导与执行视图由**同一个** tea.Program 承载。
//
// 为什么必须合一：原先拆成两次程序调用——向导收完答案就退出、备用屏幕随之还原，
// 然后第二次调用再进执行视图。用户看到的是「确认后页面消失 → 日志打到终端行里 →
// 又弹出一次新页面」，而 dpanel 的形态是全程一个界面：翻页收集配置，最后一页
// 原地滚动输出。两次调用做不到这一点——第一次退出必然还原备用屏幕，第二次再进入
// 就是两进两出，中间的输出还会漏到备用屏幕之外。
//
// 分工没有变：Go 只负责界面与放行信号，安装逻辑仍由 install.sh 的子 shell 执行。
// 放行用 FIFO：Go 在向导确认后先写答案文件、再打开 FIFO 写端，
// 后台执行子 shell 正阻塞在同一个 FIFO 的读端上。

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

const (
	phaseWizard = iota
	phaseExec
)

type rootModel struct {
	opts options

	wizard wizardModel
	exec   execViewModel
	phase  int

	logPath  string
	sentinel string
	gate     string

	finished bool
	code     int
	err      error
	// quitMsg 是退出后打印到终端的内容（例如日志路径）。退出备用屏幕后整屏已经
	// 还原，这是唯一还允许写出去的东西。
	quitMsg string
}

func newRootModel(opts options) rootModel {
	m := rootModel{
		opts:     opts,
		logPath:  opts.watchLog,
		sentinel: opts.watchSentinel,
		gate:     opts.runGate,
	}

	// 命令行路径：install.sh 直接启动了后台执行体（没有门闸需要放行），
	// 所以一进来就是执行视图，没有向导可翻。判据是「给了 --watch-log 但没有
	// --run-gate」——向导路径必然两者都有，因为它要靠门闸协调执行时机。
	if opts.watchLog != "" && opts.runGate == "" {
		m.phase = phaseExec
		m.exec = m.newExecModel()
		return m
	}

	m.wizard = newWizard(opts)
	m.phase = phaseWizard
	return m
}

// newExecModel 按命令行参数构造执行视图。
func (m rootModel) newExecModel() execViewModel {
	return newExecViewModel(execViewOptions{
		logPath:     m.opts.watchLog,
		sentinel:    m.opts.watchSentinel,
		title:       m.opts.watchTitle,
		summary:     m.opts.watchSummary,
		summaryPath: m.opts.watchSummaryFile,
	})
}

func (m rootModel) Init() tea.Cmd {
	if m.phase == phaseExec {
		return m.exec.Init()
	}
	return m.wizard.Init()
}

func (m rootModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if m.phase == phaseExec {
		return m.updateExec(msg)
	}
	return m.updateWizard(msg)
}

func (m rootModel) updateWizard(msg tea.Msg) (tea.Model, tea.Cmd) {
	next, cmd := m.wizard.Update(msg)
	if w, ok := next.(wizardModel); ok {
		m.wizard = w
	}

	if m.wizard.aborted {
		// 用户在向导里取消（Ctrl+C，或确认页答「否」）：什么都没发生。
		m.finished = true
		m.code = exitCancelled
		return m, tea.Quit
	}
	if !m.wizard.done {
		return m, cmd
	}

	// 向导结束。注意丢掉向导返回的 cmd：它在 done 时是 tea.Quit，而这里要做的
	// 是原地切阶段，不是结束程序。
	m.persistAnswers()

	// 只有 install / configure 有「执行」这件事。其它动作（启动、卸载、密钥面板…）
	// 由 install.sh 在 Go 退出后处理，把用户留在空的日志页上没有意义。
	// 没有 --watch-log（DSH_NO_EXEC_VIEW=1，或调用方只要答案）时同样不进执行视图。
	if m.opts.watchLog != "" && (m.wizard.answers["action"] == "install" || m.wizard.answers["action"] == "configure") {
		return m.startExec()
	}

	m.finished = true
	return m, tea.Quit
}

// persistAnswers 落答案文件，然后放行后台执行子 shell。
//
// 顺序不能反：子 shell 一被放行就会立刻去读答案文件，先放行再写会读到空文件。
// FIFO 在这里既表示「用户已确认」，也是这两步之间的顺序保证。
//
// 无条件放行，哪怕用户选的不是安装动作：bash 那侧的执行体是**先**起好的（它要
// 等答案才能判断该不该干活），不放行它就永远卡在门闸上，bash 的 wait 也跟着挂住。
// 判断「这轮要不要真的装」由执行体自己看答案决定，界面不替它做这个决定。
func (m *rootModel) persistAnswers() {
	// --dry-run 是调试用：只打印将要执行的命令，不落任何文件、也不放行执行体
	// （放行了就会真的开始装）。
	if m.opts.dryRun {
		return
	}
	if m.opts.answersFile != "" {
		file, err := os.Create(m.opts.answersFile)
		if err != nil {
			m.err = fmt.Errorf("无法写入答案文件：%w", err)
			return
		}
		emitAnswers(file, m.wizard.answers)
		if err := file.Close(); err != nil {
			m.err = fmt.Errorf("无法写入答案文件：%w", err)
			return
		}
	}
	if err := releaseGate(m.gate); err != nil {
		m.err = err
	}
}

// startExec 切到执行视图。调用前 persistAnswers 已经落好答案并放行了执行体，
// 所以这里只负责把界面换过去。
func (m rootModel) startExec() (tea.Model, tea.Cmd) {
	m.exec = m.newExecModel()
	// 尺寸从向导继承：切换阶段不会再收到一次 WindowSizeMsg，不继承的话执行视图
	// 第一帧宽度为 0，会渲染成空白，直到终端下一次改变大小。
	m.exec.width = m.wizard.width
	m.exec.height = m.wizard.height
	m.phase = phaseExec
	return m, m.exec.Init()
}

func (m rootModel) updateExec(msg tea.Msg) (tea.Model, tea.Cmd) {
	next, cmd := m.exec.Update(msg)
	if e, ok := next.(execViewModel); ok {
		m.exec = e
	}
	if m.exec.done {
		// 退出码跟随被执行命令，而不是跟随界面：界面只负责把结果透出去，
		// 免得出现「装失败了但界面退 0」。
		m.code = m.exec.code
	}
	if m.exec.quitMsg != "" {
		m.quitMsg = m.exec.quitMsg
	}
	if m.exec.quit {
		m.finished = true
	}
	return m, cmd
}

func (m rootModel) View() string {
	if m.phase == phaseExec {
		return m.exec.View()
	}
	return m.wizard.View()
}

// gateWaitTimeout 是等待门闸读端出现的上限。
//
// 变量而不是常量：测试里没有读端，按默认值每个用例都要白等 10 秒。
// 生产环境下这段时间只在「后台执行子 shell 起得异常慢」时才用得上。
var gateWaitTimeout = 10 * time.Second

// releaseGate 打开 FIFO 写端并写入一个换行，放行后台的执行子 shell。
//
// 用 O_NONBLOCK 而不是普通打开：普通打开会阻塞到有读端出现，而这段代码跑在
// Bubble Tea 的 Update 里——万一 bash 那边的读端没起来（子 shell 提前失败），
// 界面会整个冻住，用户连 Ctrl+C 都按不动。O_NONBLOCK 在没有读端时立刻返回 ENXIO，
// 于是可以有限次重试加超时收尾。正常情况第一次就成功。
func releaseGate(path string) error {
	if path == "" {
		return nil
	}
	deadline := time.Now().Add(gateWaitTimeout)
	for {
		f, err := os.OpenFile(path, os.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err == nil {
			_, werr := f.Write([]byte("\n"))
			f.Close()
			if werr != nil {
				return fmt.Errorf("无法放行后台执行：%w", werr)
			}
			return nil
		}
		// 文件不存在与「有文件但没读端」都不该让界面停住：前者说明调用方没建门闸
		//（例如测试或某个调用点漏了 mkfifo），后者是执行体还没起来。两种情况都
		// 继续重试到超时，然后放弃——放弃也不影响切页，只是执行体会一直等下去。
		if !errors.Is(err, syscall.ENXIO) && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("无法打开执行门闸 %s：%w", path, err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("等待后台执行进程就绪超时（%s）", path)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
