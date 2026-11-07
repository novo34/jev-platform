"""Validate the handoff offline and optionally reconcile it with Foundation."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PROGRESS = "PROGRESO.md"
SECTIONS = (
    "Identificación", "Estado canónico del proyecto", "Objetivo actual",
    "Última sesión de desarrollo", "Funcionalidades completadas", "Pruebas y evidencias",
    "Pull requests y commits", "Problemas detectados", "Problemas resueltos",
    "Trabajo pendiente", "Bloqueos y dependencias", "Decisiones y autorizaciones",
    "Higiene del repositorio", "Siguiente paso exacto",
    "Instrucciones para continuar en otra sesión",
)
SHA = r"[0-9a-f]{40}"
TASK = r"PLT-\d{3,}"
STATUSES = {"TODO", "READY", "IN_PROGRESS", "VERIFYING", "BLOCKED", "DONE", "DEFERRED"}
CREDENTIAL = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|"
    r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b|"
    r"://[^\s/:]+:[^\s/@]+@|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|"
    r"(?im:^[ \t]*[\x22\x27]?(?:[\w-]*(?:PASSWORD|SECRET|TOKEN|API_KEY)|COOKIE)"
    r"[\x22\x27]?[ \t]*[:=][ \t]*[\x22\x27]?[A-Za-z0-9_./+=!@#$%&*-]{8,})"
)
EVIDENCE = {
    "pr": r"pull/\d+",
    "ci": r"actions/runs/\d+",
    "review": r"pull/\d+#(?:issuecomment-|pullrequestreview-)\d+",
}
MILESTONE_PATHS = (
    "apps/", "packages/", "deploy/", "scripts/", ".github/workflows/",
    "docs/product-specs/", "AGENTS.md", "package.json", "package-lock.json",
    "docker-compose.yml", "docker-compose.staging.yml", "tsconfig.base.json", ".env.example",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def validate_checkpoint(markdown):
    """Validate checkpoint structure and declared evidence without opening links."""
    require(not CREDENTIAL.search(markdown), "posible credencial en PROGRESO.md")
    parts = re.split(r"^## (.+)$", markdown, flags=re.MULTILINE)
    sections = dict(zip(parts[1::2], parts[2::2]))
    require(tuple(parts[1::2]) == SECTIONS and all(s.strip() for s in sections.values()),
            "secciones obligatorias ausentes, duplicadas, desordenadas o vacías")
    blocks = re.findall(r"^```json\n(.+?)\n```$", sections["Estado canónico del proyecto"],
                        flags=re.MULTILINE | re.DOTALL)
    require(len(blocks) == 1, "se requiere un bloque JSON de estado canónico")
    data = json.loads(blocks[0])
    for key in ("foundation_sha", "platform_sha"):
        require(re.fullmatch(SHA, data[key]), f"{key} debe ser un SHA completo")
    completed = data["last_completed"]
    require(re.fullmatch(TASK, completed["task"]) and completed["status"] == "DONE",
            "la referencia de cierre debe identificar una tarea PLATFORM DONE")
    for key, path in EVIDENCE.items():
        require(re.fullmatch("https://github.com/novo34/jev-platform/" + path, completed[key]),
                f"DONE requiere una referencia de {key} de Platform")
    next_task = data["next_task"]
    if next_task is not None:
        require(re.fullmatch(TASK, next_task["task"]) and next_task["status"] in STATUSES - {"DONE", "DEFERRED"},
                "la próxima referencia debe identificar una tarea PLATFORM no terminal")
        require(next_task["task"] != completed["task"], "la próxima tarea coincide con la tarea cerrada")
    require(type(data["requires_operator_authorization"]) is bool, "falta la decisión de autorización")
    require(data["next_action"].strip(), "falta la acción concreta de reanudación")
    return data


def reconcile(data, foundation):
    """Verify task status and the next authorized action against a clean Foundation revision."""
    # Import PyYAML only in explicit reconciliation mode, as Foundation already requires it.
    import yaml

    require(run("git", "rev-parse", "HEAD", cwd=foundation) == data["foundation_sha"],
            "SHA de Foundation distinto al checkpoint")
    require(not run("git", "status", "--porcelain", cwd=foundation),
            "el worktree de Foundation debe estar limpio")
    backlog = yaml.safe_load((foundation / "backlog/jev-master-tasks.yaml").read_text(encoding="utf-8"))
    tasks = {task["id"]: task for task in backlog["tasks"] if task["scope"] == "PLATFORM"}
    completed = next((task for task in reversed(tasks.values()) if task["status"] == "DONE"), None)
    require(completed and completed["id"] == data["last_completed"]["task"],
            "el último cierre difiere del backlog canónico")
    require(completed.get("verified_by")
            and len(completed.get("completion_evidence", [])) >= len(completed["acceptance"]),
            "Foundation carece de estado DONE o evidencia suficiente")
    cursor = json.loads(run("python3", "-B", "scripts/next_task.py", "--check", cwd=foundation))
    task_id = cursor["first_incomplete_task_id"]
    expected = {"task": task_id, "status": tasks[task_id]["status"]} if task_id else None
    require(data["next_task"] == expected
            and data["requires_operator_authorization"] == cursor["requires_operator_authorization"],
            "el siguiente paso contradice el Development Control Gate")


def require_ancestor(commit, ref, message):
    """Require a recorded revision to be reachable from the specified Git ref."""
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", commit, ref], cwd=ROOT,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    require(result.returncode == 0, message)


def require_update(base):
    """Require a checkpoint change when the PR touches a material path."""
    changed = subprocess.check_output(
        ["git", "diff", "--no-renames", "--name-only", "-z", base, "HEAD"], cwd=ROOT,
    )
    paths = {path for path in os.fsdecode(changed).split("\0") if path}
    material = any(path.startswith(MILESTONE_PATHS) for path in paths)
    require(not material or PROGRESS in paths, "actualiza PROGRESO.md en la misma PR del hito")


def main():
    """Validate the checkpoint and apply the extra PR and Foundation checks when requested."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="base de la PR para exigir la actualización del hito")
    parser.add_argument("--foundation", type=Path, help="checkout limpio del SHA de Foundation")
    args = parser.parse_args()
    try:
        data = validate_checkpoint((ROOT / PROGRESS).read_text(encoding="utf-8"))
        require_ancestor(data["platform_sha"], "HEAD", "platform_sha no pertenece al historial del checkout")
        if args.base:
            require(re.fullmatch(SHA, args.base), "la base de la PR debe ser un SHA completo")
            require_ancestor(data["platform_sha"], args.base, "platform_sha aún no está integrado en la base de la PR")
            require_update(args.base)
        if args.foundation:
            reconcile(data, args.foundation.resolve())
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.CalledProcessError) as exc:
        # Keep invalid field values out of the log.
        parser.exit(1, f"PROGRESO.md inválido ({type(exc).__name__}).\n" if type(exc) is not ValueError
                    else f"PROGRESO.md inválido: {exc}.\n")
    print("PROGRESO.md válido. " + (
        "Coherencia con el checkout de Foundation comprobada."
        if args.foundation else "Referencias declaradas; Foundation y GitHub requieren comprobación externa."
    ))


if __name__ == "__main__":
    main()
