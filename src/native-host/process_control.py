import os
import subprocess


def creation_flags():
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def terminate_process_tree(process):
    if process is None or process.poll() is not None:
        return

    pid = getattr(process, "pid", None)
    if os.name == "nt" and pid:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                creationflags=creation_flags(),
            )
            return
        except Exception:
            pass

    try:
        process.terminate()
    except Exception:
        try:
            process.kill()
        except Exception:
            pass
