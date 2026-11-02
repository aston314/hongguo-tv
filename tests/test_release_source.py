import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.verify_release_source import verify


def git(path, *args):
    return subprocess.run(
        ["git", *args], cwd=path, check=True, text=True,
        capture_output=True,
    ).stdout.strip()


class ReleaseSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.seed = self.root / "seed"
        self.seed.mkdir()
        git(self.seed, "init", "-b", "main")
        git(self.seed, "config", "user.name", "Release test")
        git(self.seed, "config", "user.email", "release-test@example.invalid")
        (self.seed / "README.md").write_text("main\n")
        git(self.seed, "add", "README.md")
        git(self.seed, "commit", "-m", "main baseline")
        self.main_sha = git(self.seed, "rev-parse", "HEAD")
        self.remote = self.root / "remote.git"
        git(self.root, "init", "--bare", str(self.remote))
        git(self.seed, "remote", "add", "origin", str(self.remote))
        git(self.seed, "push", "origin", "main")
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        self.clone = self.root / "clone"
        git(self.root, "clone", str(self.remote), str(self.clone))
        git(self.clone, "config", "user.name", "Release test")
        git(self.clone, "config", "user.email", "release-test@example.invalid")
        self.previous_cwd = Path.cwd()
        os.chdir(self.clone)

    def tearDown(self):
        os.chdir(self.previous_cwd)
        self.temp.cleanup()

    def test_manual_build_requires_main(self):
        self.assertIn("main", verify("workflow_dispatch", "refs/heads/main", self.main_sha))
        with self.assertRaisesRegex(ValueError, "must run from refs/heads/main"):
            verify("workflow_dispatch", "refs/heads/feature", self.main_sha)
        with self.assertRaisesRegex(ValueError, "does not match GITHUB_SHA"):
            verify("workflow_dispatch", "refs/heads/main", "0" * 40)

    def test_tag_must_be_on_main_history(self):
        git(self.seed, "tag", "v1.2.3", self.main_sha)
        git(self.seed, "push", "origin", "v1.2.3")
        git(self.clone, "fetch", "--tags", "origin")
        self.assertIn("included in origin/main", verify("push", "refs/tags/v1.2.3", self.main_sha))

    def test_shallow_tag_checkout_fetches_main_ancestry(self):
        git(self.seed, "tag", "v1.2.5", self.main_sha)
        (self.seed / "later.txt").write_text("later main commit\n")
        git(self.seed, "add", "later.txt")
        git(self.seed, "commit", "-m", "later main commit")
        git(self.seed, "push", "origin", "main", "--tags")
        shallow = self.root / "shallow"
        git(self.root, "clone", "--depth=1", "--branch", "v1.2.5", self.remote.as_uri(), str(shallow))
        os.chdir(shallow)
        self.assertIn("included in origin/main", verify("push", "refs/tags/v1.2.5", self.main_sha))

    def test_unmerged_feature_tag_is_rejected(self):
        git(self.seed, "checkout", "-b", "feature")
        (self.seed / "feature.txt").write_text("unmerged\n")
        git(self.seed, "add", "feature.txt")
        git(self.seed, "commit", "-m", "unmerged feature")
        feature_sha = git(self.seed, "rev-parse", "HEAD")
        git(self.seed, "tag", "v1.2.4", feature_sha)
        git(self.seed, "push", "origin", "feature", "v1.2.4")
        git(self.clone, "fetch", "--tags", "origin")
        git(self.clone, "fetch", "origin", "feature:refs/remotes/origin/feature")
        git(self.clone, "checkout", "--detach", feature_sha)
        with self.assertRaisesRegex(ValueError, "not an ancestor of origin/main"):
            verify("push", "refs/tags/v1.2.4", feature_sha)

    def test_desktop_reads_annotated_remote_tag_without_replacing_checkout_tag(self):
        git(self.seed, "tag", "-a", "v1.2.6", "-m", "release", self.main_sha)
        git(self.seed, "push", "origin", "v1.2.6")
        remote_tag = git(self.seed, "rev-parse", "refs/tags/v1.2.6")
        # actions/checkout can represent the remote annotated tag locally by
        # its commit. Fetching back into the same tag would reject clobbering.
        git(self.clone, "tag", "v1.2.6", self.main_sha)
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/desktop.yml").read_text(encoding="utf-8")
        commands = workflow.split('          git fetch --no-tags origin "refs/tags/v$APP_VERSION"', 1)[1]
        commands = 'git fetch --no-tags origin "refs/tags/v$APP_VERSION"' + commands.split('          if [[ "${GITHUB_REF_TYPE:-}"', 1)[0]
        # Python's Windows PATH may resolve bash to the WSL launcher even
        # though Actions runs the surrounding step with Git for Windows Bash.
        bash = "bash"
        if os.name == "nt":
            git_executable = Path(shutil.which("git"))
            bash = next(str(parent / "bin/bash.exe") for parent in git_executable.parents
                        if (parent / "bin/bash.exe").is_file())
        result = subprocess.run([bash, "-e", "-c", commands], cwd=self.clone,
                                env={**os.environ, "APP_VERSION": "1.2.6", "GITHUB_SHA": self.main_sha},
                                text=True, capture_output=True)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(self.main_sha, git(self.clone, "rev-parse", "refs/tags/v1.2.6"))
        self.assertEqual(remote_tag, git(self.remote, "rev-parse", "refs/tags/v1.2.6"))
        wrong = subprocess.run([bash, "-e", "-c", commands], cwd=self.clone,
                               env={**os.environ, "APP_VERSION": "1.2.6", "GITHUB_SHA": "0" * 40},
                               text=True, capture_output=True)
        self.assertNotEqual(0, wrong.returncode)
        (self.clone / "core").mkdir()
        (self.clone / "core/playback.txt").write_text("different application source\n")
        git(self.clone, "add", "core/playback.txt")
        git(self.clone, "commit", "-m", "application differs from release")
        changed = subprocess.run([bash, "-e", "-c", commands], cwd=self.clone,
                                 env={**os.environ, "APP_VERSION": "1.2.6",
                                      "GITHUB_SHA": git(self.clone, "rev-parse", "HEAD")},
                                 text=True, capture_output=True)
        self.assertNotEqual(0, changed.returncode)


if __name__ == "__main__":
    unittest.main()
