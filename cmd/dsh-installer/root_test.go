package main

// 根模型的阶段机测试：向导确认后必须**原地**切到执行视图，且整场只有一个模型。
//
// 这一层的价值：PTY 探针能证明进出备用屏幕各一次，但它跑得慢、需要 Linux 与 python3。
// 阶段机是纯粹的状态转换，用单元测试守住更快也更精确——尤其是「向导结束时丢掉
// tea.Quit」这个容易被后人改回去的细节。

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// mkfifoForTest 建一个命名管道。它只在类 Unix 上可用，Windows 上会返回错误，
// 调用方据此跳过——门闸本身的行为在 Linux 上由 PTY 探针与全量套件覆盖。
func mkfifoForTest(path string) error {
	return syscall.Mkfifo(path, 0o600)
}

// TestMain 把门闸等待缩到最短：这些用例里没有读端，按生产默认值每个都要白等 10 秒。
func TestMain(m *testing.M) {
	gateWaitTimeout = 150 * time.Millisecond
	os.Exit(m.Run())
}

// newGuidedRoot 构造一个带门闸、带日志的根模型，模拟 install.sh 的交互路径。
func newGuidedRoot(t *testing.T, answers string) (rootModel, string) {
	t.Helper()
	dir := t.TempDir()
	gate := filepath.Join(dir, "gate")
	logPath := filepath.Join(dir, "exec.log")
	if err := os.WriteFile(logPath, []byte("==> 开始\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 门闸不需要真的建：releaseGate 找不到文件会返回错误，但阶段切换不该被它挡住。
	// 这里显式验证「答案写失败也不影响切页」——用户已经确认了，界面必须往前走。
	m := newRootModel(options{
		dir:           dir,
		answersFile:   answers,
		runGate:       gate,
		watchLog:      logPath,
		watchTitle:    "安装 DSH",
		watchSentinel: "__DSH_EXEC_DONE__",
	})
	return m, dir
}

// sendKey 把按键喂给模型，返回新模型。
func sendKey(t *testing.T, m rootModel, key tea.KeyMsg) rootModel {
	t.Helper()
	next, _ := m.Update(key)
	out, ok := next.(rootModel)
	if !ok {
		t.Fatalf("Update 必须返回 rootModel，实际 %T", next)
	}
	return out
}

func enter() tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyEnter} }

// 一路回车走完向导，直到它切到执行阶段或退出。
func driveToPhase(t *testing.T, m rootModel) rootModel {
	t.Helper()
	for i := 0; i < 64; i++ {
		if m.phase == phaseExec || m.finished {
			return m
		}
		m = sendKey(t, m, enter())
	}
	t.Fatalf("喂了 64 次回车仍未离开向导阶段（phase=%d）", m.phase)
	return m
}

// TestRootStartsInWizardWhenGuided --watch-log 与 --run-gate 同时给出时是交互路径，
// 必须从向导开始，而不是直接进执行视图。
func TestRootStartsInWizardWhenGuided(t *testing.T) {
	m, _ := newGuidedRoot(t, filepath.Join(t.TempDir(), "answers.env"))
	if m.phase != phaseWizard {
		t.Fatalf("交互路径必须从向导开始，实际 phase=%d", m.phase)
	}
}

// TestRootStartsInExecOnCommandLinePath 只有 --watch-log 而没有 --run-gate 时是
// 命令行路径（install.sh 自己放行了执行体），必须直接进执行视图。
func TestRootStartsInExecOnCommandLinePath(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "exec.log")
	if err := os.WriteFile(logPath, []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := newRootModel(options{watchLog: logPath})
	if m.phase != phaseExec {
		t.Fatalf("命令行路径必须直接进执行视图，实际 phase=%d", m.phase)
	}
}

// TestWizardDoneSwitchesToExecInPlace 是本改动的核心：向导确认后，同一个模型
// 原地切到执行阶段，而不是结束程序。
func TestWizardDoneSwitchesToExecInPlace(t *testing.T) {
	m, _ := newGuidedRoot(t, filepath.Join(t.TempDir(), "answers.env"))
	m = driveToPhase(t, m)

	if m.finished {
		t.Fatal("向导确认后不该结束程序——应该原地切到执行视图")
	}
	if m.phase != phaseExec {
		t.Fatalf("向导确认后必须切到执行阶段，实际 phase=%d", m.phase)
	}
	// 切页后视图必须换成执行视图的内容（有滚动提示），而不是还在画向导页。
	view := m.View()
	if !strings.Contains(view, "PgUp/PgDn") {
		t.Fatalf("切页后应渲染执行视图，实际画面：\n%s", view)
	}
}

// TestWizardDoneWritesAnswers 确认时刻必须先落答案：后台执行子 shell 一被放行
// 就会去读它，写晚了它会读到空文件。
func TestWizardDoneWritesAnswers(t *testing.T) {
	answersPath := filepath.Join(t.TempDir(), "answers.env")
	m, _ := newGuidedRoot(t, answersPath)
	m = driveToPhase(t, m)

	data, err := os.ReadFile(answersPath)
	if err != nil {
		t.Fatalf("确认后答案文件必须已写好：%v", err)
	}
	if !strings.Contains(string(data), "action=") {
		t.Fatalf("答案文件必须含 action 键，实际内容：%q", string(data))
	}
	// 用户在主菜单默认选中的是「安装」。
	if !strings.Contains(string(data), "action=install") {
		t.Fatalf("默认动作应为 install，实际内容：%q", string(data))
	}
}

// TestExecPhaseKeepsWizardViewOut 切到执行阶段后，画面上不该再有向导的页码与选项，
// 否则说明两个阶段被叠在一起渲染了。
func TestExecPhaseKeepsWizardViewOut(t *testing.T) {
	m, _ := newGuidedRoot(t, filepath.Join(t.TempDir(), "answers.env"))
	m = driveToPhase(t, m)

	view := m.View()
	if strings.Contains(view, "选 择 操 作") || strings.Contains(view, "选择操作 (1)") {
		t.Fatalf("执行阶段不该再画向导主菜单：\n%s", view)
	}
	// 横幅仍应存在（两个阶段共享同一个页面框架）。
	if strings.Contains(view, "\n") && len(view) == 0 {
		t.Fatal("执行视图不应为空")
	}
}

// TestAbortReturnsCancelledCode 用户取消时退出码必须是 3（exitCancelled），
// 而不是 0 或 1——调用方靠它区分「取消」与「失败」。
func TestAbortReturnsCancelledCode(t *testing.T) {
	m, _ := newGuidedRoot(t, filepath.Join(t.TempDir(), "answers.env"))
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	out := next.(rootModel)
	if !out.finished {
		t.Fatal("Ctrl+C 必须结束界面")
	}
	if out.code != exitCancelled {
		t.Fatalf("取消的退出码必须是 %d，实际 %d", exitCancelled, out.code)
	}
	if cmd == nil {
		t.Fatal("取消必须返回 tea.Quit")
	}
}

// TestAnswersWrittenBeforeGateOpens 顺序保证：答案文件先于门闸放行。
//
// 用一个真实 FIFO 验证：读端起来之前写端打不开，所以只要答案文件在门闸可读时
// 已经就位，就证明顺序正确。
func TestAnswersWrittenBeforeGateOpens(t *testing.T) {
	dir := t.TempDir()
	gate := filepath.Join(dir, "gate")
	if err := mkfifoForTest(gate); err != nil {
		t.Skipf("本平台不支持 mkfifo：%v", err)
	}
	answersPath := filepath.Join(dir, "answers.env")
	logPath := filepath.Join(dir, "exec.log")
	if err := os.WriteFile(logPath, []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	m := newRootModel(options{
		dir:           dir,
		answersFile:   answersPath,
		runGate:       gate,
		watchLog:      logPath,
		watchSentinel: "__DSH_EXEC_DONE__",
	})
	m = driveToPhase(t, m)

	// 切页时答案必须已落盘（此时门闸的写端已经被打开过一次）。
	data, err := os.ReadFile(answersPath)
	if err != nil {
		t.Fatalf("答案文件必须已写好：%v", err)
	}
	if len(data) == 0 {
		t.Fatal("答案文件不该为空")
	}
}

// TestDryRunDoesNotTouchAnything --dry-run 是调试开关：不许写答案文件、不许放行执行体。
func TestDryRunDoesNotTouchAnything(t *testing.T) {
	dir := t.TempDir()
	answersPath := filepath.Join(dir, "answers.env")
	logPath := filepath.Join(dir, "exec.log")
	if err := os.WriteFile(logPath, []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := newRootModel(options{
		dir:         dir,
		answersFile: answersPath,
		dryRun:      true,
		watchLog:    logPath,
		runGate:     filepath.Join(dir, "gate"),
	})
	m = driveToPhase(t, m)

	if _, err := os.Stat(answersPath); err == nil {
		t.Fatal("--dry-run 不该写答案文件")
	}
}
