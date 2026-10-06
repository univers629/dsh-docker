package main

// 执行视图的单元测试：不依赖终端，直接驱动模型。
//
// 覆盖几处容易写错的地方：
//   1. 分块读取时，未以换行结束的最后一段不能被当成完整行
//   2. 结束标记被识别后，它那一行不该显示给用户，且退出码要正确解析
//   3. 完成后状态改变、操作项可用；完成前只能滚动
//   4. 中文按显示宽度截断（按 rune 截会让边框歪掉）

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-runewidth"
)

func writeLog(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "watch.log")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func appendLog(t *testing.T, path, content string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatal(err)
	}
}

func TestExecViewReadsIncrementally(t *testing.T) {
	path := writeLog(t, "第一行\n第二行\n")
	m := newExecViewModel(execViewOptions{logPath: path, sentinel: sentinelForTest})
	m = m.readMore()

	if len(m.lines) != 2 {
		t.Fatalf("应读到 2 行，实际 %d：%q", len(m.lines), m.lines)
	}
	if m.lines[0] != "第一行" || m.lines[1] != "第二行" {
		t.Fatalf("内容不符：%q", m.lines)
	}

	// 追加后再次读取，应只拿到新增的行，不重复旧内容
	appendLog(t, path, "第三行\n")
	m = m.readMore()
	if len(m.lines) != 3 {
		t.Fatalf("追加后应 3 行，实际 %d：%q", len(m.lines), m.lines)
	}
}

func TestExecViewHoldsPartialLine(t *testing.T) {
	path := writeLog(t, "完整行\n半截")
	m := newExecViewModel(execViewOptions{logPath: path, sentinel: sentinelForTest})
	m = m.readMore()

	if len(m.lines) != 1 {
		t.Fatalf("未以换行结束的行不该显示，实际 %d 行：%q", len(m.lines), m.lines)
	}
	if m.pendingLine != "半截" {
		t.Fatalf("半截行应被缓存，实际 %q", m.pendingLine)
	}

	appendLog(t, path, "的内容\n")
	m = m.readMore()
	if len(m.lines) != 2 || m.lines[1] != "半截的内容" {
		t.Fatalf("拼行失败：%q", m.lines)
	}
}

const sentinelForTest = "__DSH_EXEC_DONE__"

func TestExecViewDetectsSentinel(t *testing.T) {
	path := writeLog(t, "工作中\n"+sentinelForTest+":0\n")
	m := newExecViewModel(execViewOptions{logPath: path, sentinel: sentinelForTest})
	m = m.readMore()

	if !m.done {
		t.Fatal("应识别结束标记")
	}
	if m.code != 0 {
		t.Fatalf("退出码应为 0，实际 %d", m.code)
	}
	for _, line := range m.lines {
		if strings.Contains(line, sentinelForTest) {
			t.Fatalf("结束标记不该显示给用户：%q", m.lines)
		}
	}
}

func TestExecViewParsesNonZeroExitCode(t *testing.T) {
	path := writeLog(t, "出错了\n"+sentinelForTest+":1\n")
	m := newExecViewModel(execViewOptions{logPath: path, sentinel: sentinelForTest})
	m = m.readMore()

	if !m.done || m.code != 1 {
		t.Fatalf("应识别失败退出码，done=%v code=%d", m.done, m.code)
	}
}

func TestExecViewStripsANSI(t *testing.T) {
	path := writeLog(t, "\x1b[32m绿色的行\x1b[0m\n")
	m := newExecViewModel(execViewOptions{logPath: path, sentinel: sentinelForTest})
	m = m.readMore()

	if len(m.lines) != 1 || m.lines[0] != "绿色的行" {
		t.Fatalf("ANSI 未清理：%q", m.lines)
	}
}

func TestExecViewTruncatesByDisplayWidth(t *testing.T) {
	got := truncateWidth("中文中文中文", 6)
	if w := runewidth.StringWidth(got); w > 6 {
		t.Fatalf("截断后宽度 %d 超过 6：%q", w, got)
	}
	if !strings.HasSuffix(got, "…") {
		t.Fatalf("截断应加省略号：%q", got)
	}
	if s := truncateWidth("abc", 10); s != "abc" {
		t.Fatalf("短串不该改动：%q", s)
	}
}

func TestExecViewFollowsTailByDefault(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < 100; i++ {
		sb.WriteString("行\n")
	}
	path := writeLog(t, sb.String())
	m := newExecViewModel(execViewOptions{logPath: path, sentinel: sentinelForTest})
	m.width, m.height = 80, 24
	m = m.readMore()

	if !m.follow {
		t.Fatal("默认应处于跟随模式")
	}
	if !strings.Contains(m.View(), "行") {
		t.Fatal("视图应包含日志内容")
	}
}

func TestExecViewScrollStopsFollowing(t *testing.T) {
	path := writeLog(t, "a\nb\nc\n")
	m := newExecViewModel(execViewOptions{logPath: path, sentinel: sentinelForTest})
	m.width, m.height = 80, 24
	m = m.readMore()

	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyUp})
	got := updated.(execViewModel)
	if got.follow {
		t.Fatal("完成前上翻应停止跟随，否则用户看不到历史行")
	}
}

func TestExecViewSummaryAndOptionsOnDone(t *testing.T) {
	path := writeLog(t, "工作\n"+sentinelForTest+":0\n")
	m := newExecViewModel(execViewOptions{
		logPath:  path,
		sentinel: sentinelForTest,
		summary:  []string{"本机入口: http://127.0.0.1:3080"},
	})
	m.width, m.height = 100, 30
	m = m.readMore()

	view := m.View()
	for _, want := range []string{"已完成", "本机入口", "退出", "显示日志文件路径"} {
		if !strings.Contains(view, want) {
			t.Fatalf("完成后视图应包含 %q，实际：\n%s", want, view)
		}
	}
}

func TestExecViewShowsFailureState(t *testing.T) {
	path := writeLog(t, "出错了\n"+sentinelForTest+":1\n")
	m := newExecViewModel(execViewOptions{logPath: path, sentinel: sentinelForTest})
	m.width, m.height = 100, 30
	m = m.readMore()

	if view := m.View(); !strings.Contains(view, "失败") {
		t.Fatalf("退出码非 0 时必须显示失败状态，实际：\n%s", view)
	}
}

func TestExecViewKeepsFrameHeightStable(t *testing.T) {
	// 内容少与内容多时，页头与底部操作区的行数应一致：
	// 否则画面会随日志增长而跳动。
	short := writeLog(t, "一行\n")
	long := writeLog(t, strings.Repeat("行\n", 200))

	ms := newExecViewModel(execViewOptions{logPath: short, sentinel: sentinelForTest})
	ms.width, ms.height = 80, 24
	ms = ms.readMore()

	ml := newExecViewModel(execViewOptions{logPath: long, sentinel: sentinelForTest})
	ml.width, ml.height = 80, 24
	ml = ml.readMore()

	if strings.Count(ms.View(), "\n") != strings.Count(ml.View(), "\n") {
		t.Fatalf("帧高度应稳定：短 %d 行，长 %d 行",
			strings.Count(ms.View(), "\n"), strings.Count(ml.View(), "\n"))
	}
}

func TestExecViewMissingFileIsNotFatal(t *testing.T) {
	// 日志文件还没被创建时不该报错：install.sh 可能稍后才开始写。
	m := newExecViewModel(execViewOptions{
		logPath:  filepath.Join(t.TempDir(), "not-yet.log"),
		sentinel: sentinelForTest,
	})
	m = m.readMore()
	if m.done {
		t.Fatal("文件不存在时不该判定为完成")
	}
}
