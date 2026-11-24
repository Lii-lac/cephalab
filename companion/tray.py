"""Native Windows system tray icon (zero external dependencies: stdlib ctypes + user32/shell32).

Runs its Win32 message loop on a daemon thread so the companion stays alive quietly in the notification area instead
of showing a console window users might accidentally close.
"""
import ctypes
import sys
import threading
from pathlib import Path

from . import log as clog

if sys.platform == "win32":
    from ctypes import wintypes

    LRESULT = ctypes.c_ssize_t
    WPARAM = ctypes.c_size_t
    LPARAM = ctypes.c_ssize_t
    WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, WPARAM, LPARAM)

    WM_NULL = 0x0000
    WM_DESTROY = 0x0002
    WM_CLOSE = 0x0010
    WM_USER = 0x0400
    WM_TRAY = WM_USER + 20
    WM_LBUTTONDBLCLK = 0x0203
    WM_RBUTTONUP = 0x0205
    WM_CONTEXTMENU = 0x007B

    NIM_ADD = 0x00000000
    NIM_DELETE = 0x00000002
    NIF_MESSAGE = 0x00000001
    NIF_ICON = 0x00000002
    NIF_TIP = 0x00000004

    IMAGE_ICON = 1
    LR_LOADFROMFILE = 0x00000010
    LR_DEFAULTSIZE = 0x00000040
    IDI_APPLICATION = 32512

    MF_STRING = 0x00000000
    MF_SEPARATOR = 0x00000800
    TPM_LEFTALIGN = 0x0000
    TPM_BOTTOMALIGN = 0x0020
    TPM_RIGHTBUTTON = 0x0002
    TPM_RETURNCMD = 0x0100

    ID_OPEN = 1001
    ID_LOG = 1002
    ID_FOLDER = 1003
    ID_QUIT = 1004

    class WNDCLASSEXW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.UINT),
            ("style", wintypes.UINT),
            ("lpfnWndProc", WNDPROC),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON),
            ("hCursor", wintypes.HANDLE),
            ("hbrBackground", wintypes.HBRUSH),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
            ("hIconSm", wintypes.HICON),
        ]

    class NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("hWnd", wintypes.HWND),
            ("uID", wintypes.UINT),
            ("uFlags", wintypes.UINT),
            ("uCallbackMessage", wintypes.UINT),
            ("hIcon", wintypes.HICON),
            ("szTip", wintypes.WCHAR * 128),
            ("dwState", wintypes.DWORD),
            ("dwStateMask", wintypes.DWORD),
            ("szInfo", wintypes.WCHAR * 256),
            ("uVersion", wintypes.UINT),
            ("szInfoTitle", wintypes.WCHAR * 64),
            ("dwInfoFlags", wintypes.DWORD),
            ("guidItem", ctypes.c_byte * 16),
            ("hBalloonIcon", wintypes.HICON),
        ]

    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    _kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    _kernel32.GetModuleHandleW.restype = wintypes.HINSTANCE

    _user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
    _user32.RegisterClassExW.restype = wintypes.ATOM
    _user32.UnregisterClassW.argtypes = [wintypes.LPCWSTR, wintypes.HINSTANCE]
    _user32.UnregisterClassW.restype = wintypes.BOOL
    _user32.CreateWindowExW.argtypes = [
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
    ]
    _user32.CreateWindowExW.restype = wintypes.HWND
    _user32.DestroyWindow.argtypes = [wintypes.HWND]
    _user32.DestroyWindow.restype = wintypes.BOOL
    _user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, WPARAM, LPARAM]
    _user32.DefWindowProcW.restype = LRESULT
    _user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, WPARAM, LPARAM]
    _user32.PostMessageW.restype = wintypes.BOOL
    _user32.PostQuitMessage.argtypes = [ctypes.c_int]
    _user32.PostQuitMessage.restype = None
    _user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    _user32.GetMessageW.restype = wintypes.BOOL
    _user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    _user32.TranslateMessage.restype = wintypes.BOOL
    _user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
    _user32.DispatchMessageW.restype = LRESULT
    _user32.RegisterWindowMessageW.argtypes = [wintypes.LPCWSTR]
    _user32.RegisterWindowMessageW.restype = wintypes.UINT
    _user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    _user32.LoadImageW.restype = wintypes.HANDLE
    _user32.LoadIconW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]
    _user32.LoadIconW.restype = wintypes.HICON
    _user32.DestroyIcon.argtypes = [wintypes.HICON]
    _user32.DestroyIcon.restype = wintypes.BOOL
    _user32.CreatePopupMenu.argtypes = []
    _user32.CreatePopupMenu.restype = wintypes.HMENU
    _user32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR]
    _user32.AppendMenuW.restype = wintypes.BOOL
    _user32.SetMenuDefaultItem.argtypes = [wintypes.HMENU, wintypes.UINT, wintypes.UINT]
    _user32.SetMenuDefaultItem.restype = wintypes.BOOL
    _user32.TrackPopupMenu.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, ctypes.c_void_p]
    _user32.TrackPopupMenu.restype = wintypes.BOOL
    _user32.DestroyMenu.argtypes = [wintypes.HMENU]
    _user32.DestroyMenu.restype = wintypes.BOOL
    _user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    _user32.SetForegroundWindow.restype = wintypes.BOOL
    _user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    _user32.GetCursorPos.restype = wintypes.BOOL
    _user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
    _user32.MessageBoxW.restype = ctypes.c_int

    _shell32.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.POINTER(NOTIFYICONDATAW)]
    _shell32.Shell_NotifyIconW.restype = wintypes.BOOL


def notify_error(title: str, message: str):
    """Show a plain Windows error dialog when running without a console (no-op elsewhere)."""
    if sys.platform == "win32":
        try:
            _user32.MessageBoxW(None, message, title, 0x10)
        except Exception:
            pass


class TrayIcon:
    """Windows notification-area icon with Open / Open log / Open folder / Quit."""

    def __init__(self, icon_path: Path | None, *, on_open, on_open_log, on_open_folder, on_quit, tooltip: str = "Cephalab"):
        self.icon_path = icon_path
        self.on_open = on_open
        self.on_open_log = on_open_log
        self.on_open_folder = on_open_folder
        self.on_quit = on_quit
        self.tooltip = tooltip[:127]
        self._hwnd = None
        self._hicon = None
        self._owns_icon = False
        self._wndproc = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._taskbar_msg = 0
        self._class_name = f"CephalabTray_{id(self)}"

    def start(self) -> bool:
        if sys.platform != "win32":
            return False
        self._thread = threading.Thread(target=self._run, daemon=True, name="tray")
        self._thread.start()
        self._ready.wait(3.0)
        return bool(self._hwnd)

    def stop(self):
        if sys.platform != "win32":
            return
        hwnd = self._hwnd
        if hwnd:
            try:
                _user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
            except Exception:
                pass
        if self._thread and self._thread.is_alive() and threading.current_thread() is not self._thread:
            self._thread.join(timeout=2.0)

    def _nid(self) -> "NOTIFYICONDATAW":
        nid = NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        nid.hWnd = self._hwnd
        nid.uID = 1
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
        nid.uCallbackMessage = WM_TRAY
        nid.hIcon = self._hicon
        nid.szTip = self.tooltip
        return nid

    def _load_icon(self):
        if self.icon_path and self.icon_path.is_file():
            h = _user32.LoadImageW(None, str(self.icon_path), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE)
            if h:
                self._hicon = h
                self._owns_icon = True
                return
        self._hicon = _user32.LoadIconW(None, ctypes.cast(IDI_APPLICATION, wintypes.LPCWSTR))
        self._owns_icon = False

    def _add_icon(self):
        if self._hwnd and self._hicon:
            nid = self._nid()
            _shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid))

    def _remove_icon(self):
        if self._hwnd:
            nid = NOTIFYICONDATAW()
            nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
            nid.hWnd = self._hwnd
            nid.uID = 1
            _shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(nid))

    def _show_menu(self):
        menu = _user32.CreatePopupMenu()
        if not menu:
            return
        try:
            _user32.AppendMenuW(menu, MF_STRING, ID_OPEN, "Open Cephalab")
            _user32.SetMenuDefaultItem(menu, ID_OPEN, 0)
            _user32.AppendMenuW(menu, MF_STRING, ID_LOG, "Open log")
            _user32.AppendMenuW(menu, MF_STRING, ID_FOLDER, "Open data folder")
            _user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
            _user32.AppendMenuW(menu, MF_STRING, ID_QUIT, "Quit Cephalab")
            pt = wintypes.POINT()
            _user32.GetCursorPos(ctypes.byref(pt))
            _user32.SetForegroundWindow(self._hwnd)
            cmd = _user32.TrackPopupMenu(menu, TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON | TPM_RETURNCMD, pt.x, pt.y, 0, self._hwnd, None)
            _user32.PostMessageW(self._hwnd, WM_NULL, 0, 0)
        finally:
            _user32.DestroyMenu(menu)
        if cmd == ID_OPEN:
            self._call(self.on_open)
        elif cmd == ID_LOG:
            self._call(self.on_open_log)
        elif cmd == ID_FOLDER:
            self._call(self.on_open_folder)
        elif cmd == ID_QUIT:
            self._call(self.on_quit)

    def _call(self, fn):
        if fn is None:
            return
        try:
            fn()
        except Exception:
            clog.get().exception("Tray action failed")

    def _run(self):
        hinst = _kernel32.GetModuleHandleW(None)
        self._taskbar_msg = _user32.RegisterWindowMessageW("TaskbarCreated")

        def proc(hwnd, msg, wparam, lparam):
            if msg == WM_TRAY:
                ev = lparam & 0xFFFF
                if ev == WM_LBUTTONDBLCLK:
                    self._call(self.on_open)
                    return 0
                if ev in (WM_RBUTTONUP, WM_CONTEXTMENU):
                    self._show_menu()
                    return 0
            elif msg == self._taskbar_msg and self._taskbar_msg:
                self._add_icon()
                return 0
            elif msg == WM_CLOSE:
                self._remove_icon()
                _user32.DestroyWindow(hwnd)
                return 0
            elif msg == WM_DESTROY:
                _user32.PostQuitMessage(0)
                return 0
            return _user32.DefWindowProcW(hwnd, msg, wparam, lparam)

        self._wndproc = WNDPROC(proc)
        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.lpfnWndProc = self._wndproc
        wc.hInstance = hinst
        wc.lpszClassName = self._class_name

        if not _user32.RegisterClassExW(ctypes.byref(wc)):
            clog.get().warning("Tray RegisterClassExW failed (err=%s)", ctypes.get_last_error())
            self._ready.set()
            return

        self._hwnd = _user32.CreateWindowExW(0, self._class_name, "Cephalab", 0, 0, 0, 0, 0, None, None, hinst, None)
        if not self._hwnd:
            clog.get().warning("Tray CreateWindowExW failed (err=%s)", ctypes.get_last_error())
            _user32.UnregisterClassW(self._class_name, hinst)
            self._ready.set()
            return

        self._load_icon()
        self._add_icon()
        clog.get().info("System tray icon ready")
        self._ready.set()

        msg = wintypes.MSG()
        while _user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            _user32.TranslateMessage(ctypes.byref(msg))
            _user32.DispatchMessageW(ctypes.byref(msg))

        self._remove_icon()
        if self._owns_icon and self._hicon:
            _user32.DestroyIcon(self._hicon)
        self._hicon = None
        self._hwnd = None
        _user32.UnregisterClassW(self._class_name, hinst)
