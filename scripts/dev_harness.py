"""Run the installed DeepSeek Harness against a THROWAWAY home with this plugin installed, to try the interface in a browser.

    python scripts/dev_harness.py up                   # create the home (first time), pack and install the plugin, serve; prints the URL
    python scripts/dev_harness.py down    # stop the server (the home is kept so state survives)
    python scripts/dev_harness.py clean   # stop the server and delete the throwaway home

Safety: everything lives in one temporary folder (`DSH_HOME`), never the user's real `~/.dsh`; the model is a stub that nothing listens
on, so no credentials and no network are involved. The folder path is kept in `dev/harness-home.txt` (git-ignored).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "dev" / "harness-home.txt"
PROFILE = "tamerucheck"
APP = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "DeepSeek Harness" / "resources" / "runtime"
DSH = APP / "cli" / "bin" / "dsh.cmd"
BUNDLED = Path.home() / ".dsh" / "dsh-runtimes" / "dsh-primary-runtime" / "dependencies"  # only READ: its node and pnpm and python


def home() -> Path:
    if STATE.exists():
        path = Path(STATE.read_text(encoding="utf-8").strip())
        if path.exists():
            return path
    path = Path(tempfile.mkdtemp(prefix="tameru-dsh-"))
    STATE.parent.mkdir(exist_ok=True)
    STATE.write_text(str(path), encoding="utf-8")
    return path


def run(args: list[str], env: dict[str, str], cwd: Path | None = None, timeout: int = 180) -> subprocess.CompletedProcess:
    return subprocess.run(args, env=env, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def setup(dsh_home: Path) -> dict[str, str]:
    env = {**os.environ, "DSH_HOME": str(dsh_home), "TAMERU_STUB_KEY": "stub-not-a-secret"}
    profile = dsh_home / "profiles" / PROFILE
    if not profile.exists():
        result = run([str(DSH), PROFILE, "--from-default-profile", "web", "--dump-config"], env, dsh_home)
        if result.returncode != 0:
            sys.exit(f"could not create the profile: {result.stderr[:400]}")
    node = BUNDLED / "node" / "bin" / "node.exe"
    pnpm = BUNDLED / "pnpm" / "bin" / "pnpm.cjs"
    built = run([shutil.which("node") or "node", "scripts/build.mjs"], env, ROOT)
    if built.returncode != 0:
        sys.exit(f"build failed: {built.stderr[:400]}")
    for old in ROOT.glob("dsh-tameru-*.tgz"):
        old.unlink()
    packed = run([shutil.which("npm") or "npm", "pack", "--silent"], env, ROOT, 120)
    if packed.returncode != 0:
        sys.exit(f"pack failed: {packed.stderr[:400]}")
    tgz = ROOT / packed.stdout.strip().splitlines()[-1]
    added = run([str(node), str(pnpm), "add", str(tgz), "--ignore-workspace", "--offline"], env, profile, 180)
    tgz.unlink(missing_ok=True)
    if added.returncode != 0:
        sys.exit(f"install failed: {added.stderr[:400] or added.stdout[-400:]}")
    manifest = json.loads((profile / "package.json").read_text(encoding="utf-8"))
    bundles = manifest["dsh"]["profile"]["bundles"]
    if "dsh-tameru" not in bundles:
        bundles.append("dsh-tameru")
    (profile / "package.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    patch = profile / "cordis.patch.yml"
    text = patch.read_text(encoding="utf-8")
    if "stub-ai" not in text:
        text = text.replace("\n[]\n", "\n")
        python = BUNDLED / "python" / "python.exe"
        text += f"""
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: stub-ai
    model: stub-model
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      stub-ai:
        displayName: Stub model (nothing listens here)
        api: openai-completions
        baseURL: http://127.0.0.1:9/v1
        apiKeyEnv: TAMERU_STUB_KEY
        models:
          - id: stub-model
            name: stub-model
            contextWindow: 128000
            maxTokens: 8000
- id: tameru
  config:
    pythonPath: {python}
"""
        patch.write_text(text, encoding="utf-8")
    return env


def up() -> None:
    dsh_home = home()
    env = setup(dsh_home)
    down(quiet=True)
    log = dsh_home / "serve.log"
    handle = log.open("w")
    process = subprocess.Popen([str(DSH), PROFILE, "--no-open", "--port", "0", "--host", "127.0.0.1"], env=env, cwd=dsh_home, stdout=handle, stderr=subprocess.STDOUT, creationflags=0x00000200)
    (dsh_home / "serve.pid").write_text(str(process.pid))
    for _ in range(60):
        match = re.search(r"http://127\.0\.0\.1:\d+/\?token=\S+", log.read_text(encoding="utf-8", errors="replace"))
        if match:
            print(match.group(0))
            return
        time.sleep(1)
    sys.exit(f"the Harness did not start; see {log}")


def down(quiet: bool = False) -> None:
    if not STATE.exists():
        return
    pid_file = Path(STATE.read_text(encoding="utf-8").strip()) / "serve.pid"
    if pid_file.exists():
        subprocess.run(["taskkill", "/T", "/F", "/PID", pid_file.read_text().strip()], capture_output=True)
        pid_file.unlink(missing_ok=True)
        if not quiet:
            print("stopped")


def clean() -> None:
    down(quiet=True)
    if STATE.exists():
        target = Path(STATE.read_text(encoding="utf-8").strip())
        time.sleep(2)
        if target.name.startswith("tameru-dsh-") and target.parent == Path(tempfile.gettempdir()):
            shutil.rmtree(target, ignore_errors=True)
        STATE.unlink(missing_ok=True)
        print("removed", target)


if __name__ == "__main__":
    {"up": up, "down": down, "clean": clean}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
