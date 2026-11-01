// Paste brings the VS Code window forward and presses Ctrl+V, Enter in it — the
// extension has put the words on the clipboard and the focus in Claude Code's
// input box. Keys go to whatever window is in front, so they are only pressed
// once it is sure to be VS Code. Same steps as desktop/vscodevoice_windows.go.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AglinkVoice
{
    static class Paste
    {
        delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

        const byte VkControl = 0x11, VkMenu = 0x12, VkReturn = 0x0D, VkV = 0x56;
        const uint KeyUp = 0x0002;

        static IntPtr Find(int pid, string title)
        {
            IntPtr byPid = IntPtr.Zero, byTitle = IntPtr.Zero;
            EnumWindows((h, _) =>
            {
                if (!IsWindowVisible(h)) return true;
                var sb = new StringBuilder(512);
                GetWindowText(h, sb, sb.Capacity);
                var t = sb.ToString();
                if (!t.Contains("Visual Studio Code")) return true;
                GetWindowThreadProcessId(h, out uint p);
                if (pid > 0 && p == pid && byPid == IntPtr.Zero) byPid = h;
                if (title.Length > 0 && byTitle == IntPtr.Zero && t.Contains(title)) byTitle = h;
                return true;
            }, IntPtr.Zero);
            return byPid != IntPtr.Zero ? byPid : byTitle;
        }

        static IntPtr Front() => GetAncestor(GetForegroundWindow(), 2);

        static void Key(byte vk, bool up) => keybd_event(vk, 0, up ? KeyUp : 0, UIntPtr.Zero);

        // Send returns null when sent, else why not (in words for the user).
        public static string? Send(int pid, string title)
        {
            var h = Find(pid, title);
            if (h == IntPtr.Zero) return "VS Code 창을 찾지 못했어요";
            if (Front() != h)
            {
                if (IsIconic(h)) ShowWindow(h, 9);
                // Windows lets only the app last used change the foreground; a
                // lone Alt press counts as using this one.
                Key(VkMenu, false);
                Key(VkMenu, true);
                SetForegroundWindow(h);
                for (int i = 0; i < 20 && Front() != h; i++) Thread.Sleep(25);
                if (Front() != h) return "VS Code 창을 앞으로 가져오지 못했어요. 할 말은 클립보드에 넣어 두었어요";
                Thread.Sleep(150);
            }
            Key(VkControl, false);
            Key(VkV, false);
            Key(VkV, true);
            Key(VkControl, true);
            Thread.Sleep(120);
            if (Front() != h) return "VS Code 창이 바뀌어 보내지 못했어요. 입력칸을 확인해 주세요";
            Key(VkReturn, false);
            Key(VkReturn, true);
            return null;
        }
    }
}
