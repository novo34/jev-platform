"""Regression tests for the continuity checkpoint and its Git boundaries."""
import json
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check-progress.py"
VALIDATE = runpy.run_path(CHECK)["validate_checkpoint"]
CHECKPOINT = (ROOT / "PROGRESO.md").read_text(encoding="utf-8")


class CheckpointTests(unittest.TestCase):
    def test_valid_checkpoint(self):
        self.assertIn("platform_sha", VALIDATE(CHECKPOINT))

    def test_rejects_invalid_checkpoint(self):
        data = VALIDATE(CHECKPOINT)
        cases = {
            "duplicate section": (CHECKPOINT + "\n## Identificación\n", "secciones obligatorias"),
            "missing JSON": (CHECKPOINT.replace("```json", "```text"), "bloque JSON"),
            "credential": (CHECKPOINT + "\nTOKEN=" + "synthetic-test-value" + "\n", "posible credencial"),
            "missing evidence": (
                CHECKPOINT.replace(json.dumps(data["last_completed"]["review"]), '""', 1),
                "referencia de review",
            ),
        }
        for name, (checkpoint, message) in cases.items():
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, message):
                VALIDATE(checkpoint)


class GitBoundaryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.repo = Path(directory.name)
        self.git("init", "-q")
        self.git("config", "user.name", "JEV regression")
        self.git("config", "user.email", "regression@example.invalid")
        self.git("config", "core.quotePath", "true")
        (self.repo / "scripts").mkdir()
        shutil.copyfile(CHECK, self.repo / "scripts/check-progress.py")
        self.base = self.commit()
        self.checkpoint = self.repo / "PROGRESO.md"
        integrated = self.with_sha(self.base)
        self.checkpoint.write_text(integrated, encoding="utf-8")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def with_sha(self, sha):
        return CHECKPOINT.replace(VALIDATE(CHECKPOINT)["platform_sha"], sha, 1)

    def check(self):
        return subprocess.run(
            [sys.executable, "scripts/check-progress.py", "--base", self.base],
            cwd=self.repo, capture_output=True, text=True,
        )

    def test_unicode_path_requires_checkpoint_change(self):
        (self.repo / "apps").mkdir()
        (self.repo / "apps/niñez.ts").touch()
        self.commit()
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("actualiza PROGRESO.md", result.stderr)
        self.checkpoint.write_text(self.checkpoint.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        self.commit()
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_sha_exclusive_to_pr(self):
        (self.repo / "README.md").touch()
        unmerged = self.commit()
        self.checkpoint.write_text(self.with_sha(unmerged), encoding="utf-8")
        self.commit()
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no está integrado en la base de la PR", result.stderr)


if __name__ == "__main__":
    unittest.main()
