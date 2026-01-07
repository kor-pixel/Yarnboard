import base64
import json
import mimetypes
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Union

import webview


APP_TITLE = "YarnBoard"
APP_WIDTH = 1400
APP_HEIGHT = 900


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False)) and hasattr(sys, "_MEIPASS")


def app_root() -> Path:
    """Filesystem root for app resources."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS"))  # type: ignore[arg-type]
    return Path(__file__).resolve().parent


def web_root() -> Path:
    return app_root() / "web"


def as_file_uri(p: Path) -> str:
    return p.resolve().as_uri()


def _fd_open():
    """Compatibility for pywebview FileDialog enums (avoids deprecated OPEN_DIALOG)."""
    fd = getattr(webview, "FileDialog", None)
    if fd is not None and hasattr(fd, "OPEN"):
        return fd.OPEN
    return getattr(webview, "OPEN_DIALOG")


def _fd_save():
    """Compatibility for pywebview FileDialog enums (avoids deprecated SAVE_DIALOG)."""
    fd = getattr(webview, "FileDialog", None)
    if fd is not None and hasattr(fd, "SAVE"):
        return fd.SAVE
    return getattr(webview, "SAVE_DIALOG")


def _first_path(val: Any) -> Optional[str]:
    if val is None:
        return None
    if isinstance(val, (str, os.PathLike)):
        return os.fspath(val)
    if isinstance(val, (list, tuple)):
        if len(val) == 0:
            return None
        item = val[0]
        if isinstance(item, (str, os.PathLike)):
            return os.fspath(item)
        return str(item)
    return str(val)


def _all_paths(val: Any) -> List[str]:
    if val is None:
        return []
    if isinstance(val, (str, os.PathLike)):
        return [os.fspath(val)]
    if isinstance(val, (list, tuple)):
        out: List[str] = []
        for item in val:
            if isinstance(item, (str, os.PathLike)):
                out.append(os.fspath(item))
            else:
                out.append(str(item))
        return out
    return [str(val)]


def _guess_mime(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def _read_file_as_data_url(path: Path) -> str:
    mime = _guess_mime(path)
    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def windows_best_practice_renderer() -> str:
    return "edgechromium"


class Api:
    def __init__(self) -> None:
        self._window: Optional[webview.Window] = None

    def attach_window(self, w: webview.Window) -> None:
        self._window = w

    def _w(self) -> webview.Window:
        if self._window is None:
            return webview.windows[0]
        return self._window

    # ---------------- Debug logging ----------------

    def log(self, msg: str) -> None:
        # JS can call this to print messages into terminal
        print(msg, flush=True)

    # ---------------- File pickers ----------------

    def pick_images(self) -> List[Dict[str, Any]]:
        """Return [{ name, path, dataUrl }] for selected images."""
        w = self._w()
        file_types = ["Images (*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif)"]
        res = w.create_file_dialog(_fd_open(), allow_multiple=True, file_types=file_types)

        out: List[Dict[str, Any]] = []
        for p_str in _all_paths(res):
            p = Path(p_str)
            try:
                out.append({"name": p.name, "path": str(p), "dataUrl": _read_file_as_data_url(p)})
            except Exception as e:
                out.append({"name": p.name, "path": str(p), "error": str(e)})
        return out

    def pick_board_file(self) -> Optional[str]:
        w = self._w()
        # combined filter as some OS dialogs only expose the first entry.
        file_types = [
            "YarnBoard (*.yb;*.db;*.sqlite)",
            "YarnBoard (*.yb)",
            "SQLite Board (*.db;*.sqlite)",
            "All files (*.*)",
        ]
        res = w.create_file_dialog(_fd_open(), allow_multiple=False, file_types=file_types)
        return _first_path(res)

    def pick_save_path(self, kind: str = "yb") -> Optional[str]:
        w = self._w()
        if kind == "sqlite":
            file_types = ["SQLite Board (*.db;*.sqlite)"]
            default_name = "board.db"
        else:
            file_types = ["YarnBoard (*.yb)"]
            default_name = "board.yb"

        res = w.create_file_dialog(_fd_save(), save_filename=default_name, file_types=file_types)
        return _first_path(res)

    # ---------------- Image on-demand

    def read_image_dataurl(self, path: str) -> Dict[str, Any]:
        """Load an image path at runtime and return a data URL."""
        try:
            p = Path(path)
            if not p.exists():
                return {"ok": False, "error": f"File not found: {p}"}
            return {"ok": True, "dataUrl": _read_file_as_data_url(p), "path": str(p)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ---------------- Save / Load

    def save_board(self, save_format: str, json_text: str) -> Dict[str, Any]:
        """JS calls: save_board(fmt, json). We open a save dialog and write."""
        try:
            kind = "sqlite" if str(save_format).lower() == "sqlite" else "yb"
            if not isinstance(json_text, str) or not json_text.strip():
                return {"ok": False, "error": "Empty board JSON"}

            # validate JSON early to produce a clear error message
            data_obj = json.loads(json_text)

            save_path_str = self.pick_save_path(kind)
            if not save_path_str:
                return {"ok": False, "cancelled": True}

            save_path = Path(save_path_str)
            save_path.parent.mkdir(parents=True, exist_ok=True)

            try:
                photos = data_obj.get("photos") if isinstance(data_obj, dict) else None
                if isinstance(photos, list):
                    base_dir = save_path.parent
                    for ph in photos:
                        if not isinstance(ph, dict):
                            continue
                        pval = ph.get("path")
                        if not isinstance(pval, str) or not pval:
                            continue
                        p = Path(pval)
                        # If an absolute path is inside base_dir, store it relative.
                        if p.is_absolute():
                            try:
                                rel = p.resolve().relative_to(base_dir.resolve())
                                ph["path"] = str(rel)
                            except Exception:
                                pass
                        else:
                            # If a relative path doesn't exist relative to base_dir but the basename does, normalize.
                            candidate = base_dir / p
                            if not candidate.exists():
                                bn = base_dir / p.name
                                if bn.exists():
                                    ph["path"] = p.name
            except Exception:
                pass

            if kind == "sqlite":
                import sqlite3

                con = sqlite3.connect(str(save_path))
                try:
                    con.execute(
                        "CREATE TABLE IF NOT EXISTS board (id INTEGER PRIMARY KEY, json TEXT NOT NULL)"
                    )
                    con.execute("DELETE FROM board")
                    con.execute("INSERT INTO board (json) VALUES (?)", (json.dumps(data_obj),))
                    con.commit()
                finally:
                    con.close()
            else:
                save_path.write_text(json.dumps(data_obj), encoding="utf-8")

            return {"ok": True, "path": str(save_path)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def load_board(self, path: Any = None) -> Dict[str, Any]:
        """JS calls: load_board() or load_board(path). Returns {ok,json,path}."""
        try:
            load_path_str = _first_path(path)
            if not load_path_str:
                load_path_str = self.pick_board_file()
            if not load_path_str:
                return {"ok": False, "cancelled": True}

            p = Path(load_path_str)
            if not p.exists():
                return {"ok": False, "error": f"File not found: {p}"}

            if p.suffix.lower() in [".sqlite", ".db"]:
                import sqlite3

                con = sqlite3.connect(str(p))
                try:
                    row = con.execute("SELECT json FROM board LIMIT 1").fetchone()
                finally:
                    con.close()
                if not row:
                    return {"ok": False, "error": "No board data found in sqlite DB"}
                # validate JSON
                json.loads(row[0])
                return {"ok": True, "json": row[0], "path": str(p), "kind": "sqlite"}

            txt = p.read_text(encoding="utf-8")
            json.loads(txt)
            return {"ok": True, "json": txt, "path": str(p), "kind": "yb"}
        except Exception as e:
            return {"ok": False, "error": str(e)}


def _windows_env_defaults() -> None:
    if sys.platform.startswith("win"):
        os.environ.setdefault("PYWEBVIEW_GUI", windows_best_practice_renderer())


def main() -> None:
    _windows_env_defaults()

    wr = web_root()
    index = wr / "index.html"
    if not index.exists():
        raise FileNotFoundError(
            f"Missing web UI. Expected: {index}\n"
            f"App root resolved to: {app_root()}\n"
            f"If building with PyInstaller, ensure you --add-data 'web;web'."
        )

    api = Api()
    url = as_file_uri(index)

    window = webview.create_window(
        APP_TITLE,
        url=url,
        js_api=api,
        width=APP_WIDTH,
        height=APP_HEIGHT,
        min_size=(1100, 700),
    )
    api.attach_window(window)

    gui = os.environ.get("PYWEBVIEW_GUI")
    if sys.platform.startswith("win") and not gui:
        gui = windows_best_practice_renderer()

    webview.start(debug=bool(os.environ.get("YARNBOARD_DEBUG")), gui=gui)


if __name__ == "__main__":
    main()
