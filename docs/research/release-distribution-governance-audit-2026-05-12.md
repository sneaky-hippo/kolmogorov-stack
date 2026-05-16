# Release Distribution Governance Audit

Date: 2026-05-12

Scope: root npm package, Node SDK package, Python SDK package, legacy MCP package, VS Code extension package, GitHub Actions, Dockerfiles, Homebrew and Windows package-manager stubs, live install pages, supply-chain claims, and package dry-run output.

## Executive Summary

Kolm has several useful local distribution building blocks: a root `kolm` bin, an installable GitHub-source package shape, Node/Python/VS Code SDK source trees, a pinned server Dockerfile, lint/smoke workflows, and preview package-manager stubs. But the live distribution story is ahead of the release system.

The live docs and integrations page label npm, Homebrew, Windows package-manager, Docker, Python, Node, VS Code, and GitHub Actions paths as shipped. Current registry checks do not support that broad label. `npm view @kolm/cli`, `npm view @kolmogorov/kolm-sdk`, and `npm view kolmogorov-stack` returned 404. The Homebrew tap implied by the docs returned 404. The Windows package-manager manifest path returned 404. The public Scoop manifest check returned 404. PyPI already has a `kolm` package at version 1.1.4, but it is an unrelated Korean LM toolkit, so the local Python package name collides with an existing project.

The root GitHub install path can still be a valid preview path, but it is not the same as a published npm package. `npm pack --dry-run` for the root package produced a large 390-file package that includes research docs, tests, public site assets, fixture artifacts, workflows, scripts, and no root license file. It also omits the package lock from the package contents, so the GitHub-source install path is not a lockfile-pinned release artifact.

The GitHub composite action is out of contract with the root CLI. It calls `kolm whoami`, `kolm compile ... --json`, and `kolm verify`, while the current CLI has no `whoami` or `verify` command and `compile --help` does not document a `--json` output mode. Local command probes confirmed `whoami` and `verify` are unknown commands.

The safe launch posture is narrower: "install the root CLI from GitHub source as a preview; package-manager taps, public npm package, VS Code marketplace, signed release artifacts, SLSA provenance, Sigstore signatures, SBOMs, and GitHub Action contract are not yet release-backed."

## What Is Solid

- Root `package.json` defines the `kolm` bin at `cli/kolm.js`.
- The root CLI dispatch exists and `node .\cli\kolm.js compile --help` prints the current compile contract.
- The root Dockerfile pins a Node 22 Alpine image by digest for the server container.
- The Node SDK package is small in dry-run form and its ESM/CJS/CLI files pass syntax checks.
- The Python SDK source files passed `py_compile` under the available system Python.
- The VS Code extension package dry-run is small and `extension.js` passes `node --check`.
- The security page already caveats SLSA, Sigstore, and SBOM as target architecture rather than shipped release artifacts in its lead paragraph.

## Evidence Highlights

### Package Registry State

Live install docs show:

```text
npm i -g @kolm/cli
```

`npm view @kolm/cli version --json` returned 404. The root package name also returned 404 on npm, and the Node SDK package name returned 404. The Node SDK README is more accurate than the live page: it says the public package is not published yet and recommends a local checkout.

PyPI has a package named `kolm`, but registry metadata says it is `Korean LM toolkit for building ASR system`, authored by a different project, with homepage `github.com/scarletcho/KoLM`. The local Python `pyproject.toml` also uses `name = "kolm"`, so publishing under the intended name would collide with an existing package unless ownership/rename is resolved.

### Root Package Shape

`npm pack --dry-run --json` at the repo root reported:

- package id: `kolmogorov-stack@0.1.0`
- size: about 8.6 MB packed
- unpacked size: about 11.9 MB
- entry count: 390

The dry-run package includes public site assets, research docs, tests, fixture `.kolm` artifacts, workflows, scripts, SDK source, and server code. It does not include a root license file. Npm also warned that no `.npmignore` exists and it is using `.gitignore` fallback.

This can work for preview GitHub installs, but it is not a curated release artifact.

### GitHub Action Contract

`.github/actions/kolm-compile/action.yml` installs the root package from GitHub source, then runs:

```bash
kolm config base "$KOLM_BASE"
kolm whoami
kolm compile ... --json
kolm inspect ...
```

Local probes showed:

- `node .\cli\kolm.js whoami` exits with "unknown command: whoami".
- `node .\cli\kolm.js verify test.kolm` exits with "unknown command: verify".
- `kolm compile --help` does not document a `--json` option.

The action is labeled shipped on the live integrations page, but should be preview or blocked until a smoke test passes.

### Package Managers

The Homebrew formula under `scripts/brew/kolm.rb` explicitly says preview and has a placeholder SHA. The live integrations page labels Homebrew as shipped. The GitHub URL implied by `brew tap kolm/kolm` returned 404.

The Windows manifest under `scripts/winget/kolm.yaml` explicitly says preview and notes companion manifests are required. The live integrations page labels `winget / scoop` as shipped. GitHub checks for the expected winget path and a common Scoop bucket path returned 404.

### Python SDK Drift

The live integrations page says Python is shipped and shows:

```python
from kolm import Kolm
job = k.compile(task=..., examples_path="./tickets.jsonl")
```

The local Python package syntax is valid, but several wrapper calls are out of contract with the root CLI:

- `compile()` shells out with `--recall` and `--recipe-pack-depth`, while root CLI compile help uses `--data` and does not document those flags.
- `run()` shells out with `kolm run <artifact> --in <input> --json`, while root CLI run takes the input as a positional argument.
- `verify()` shells out to `kolm verify`, which does not exist.
- The package script entry is `recipe`, not `kolm`.

### VS Code Extension Drift

The VS Code extension is labeled preview, which is appropriate. Syntax and package dry-run are fine. But its implementation still uses legacy naming and a legacy default API host, and the replacement text asks users to import a legacy scoped package rather than the current Kolm SDK. There is no marketplace publish workflow or extension test.

### Supply Chain Claims

The security page lead paragraph is careful: SLSA provenance, Sigstore signatures, and CycloneDX SBOM are target architecture and not emitted by a release workflow yet. Source search confirms no release workflow with `id-token`, SLSA, Cosign, SBOM, npm publish, twine upload, Docker push, VS Code publish, or release-asset publishing.

The page still includes detailed cards for SLSA, Sigstore, and SBOM. These should remain explicitly roadmap until a real release workflow emits and verifies artifacts.

## Highest-Risk Gaps

### Public Install Command Points To Missing Package

The documented `@kolm/cli` npm package is not published. That is a first-command failure for users starting from `/docs`.

### Shipped Labels Are Too Broad

Homebrew, Windows package-manager, npm registry package, Node SDK publication, Python package publication, Docker release, and GitHub Action all need narrower labels.

### CI Action Can Fail On First Use

The composite action calls missing CLI commands. A user copying the live GitHub Actions snippet can fail after installing the CLI.

### Python Name Collision

The local Python package uses a name that is already occupied on PyPI by an unrelated project. This blocks a clean public package launch under the current name.

### Root Package Is Not Release-Curated

The GitHub-source package currently includes broad repo contents and lacks a root license file. It is a preview source install, not a clean package-manager release.

## Recommended Launch Contract

Use this wording until the release path is real:

> Install the preview CLI from GitHub source with `npm i -g github:sneaky-hippo/kolmogorov-stack`. Published npm, Homebrew, Windows package-manager, VS Code marketplace, Docker image, and signed release artifacts are release-candidate work and should be treated as preview until the first tagged release.

Avoid claiming:

- `@kolm/cli` is published,
- Homebrew or Windows package-manager install is shipped,
- GitHub Actions is shipped without an action smoke test,
- the Python SDK is a public PyPI package under `kolm`,
- release artifacts are signed or have SLSA/Cosign/SBOM evidence,
- Docker is shipped as a Kolm image unless a published image exists.

## Test And Governance Gaps

Add launch-blocking checks for:

- npm package availability for any package shown in public docs,
- root package dry-run contents and denylisted files,
- action smoke against the current CLI,
- Homebrew formula audit after replacing the placeholder SHA,
- winget manifest validation with all required companion files,
- Python package name ownership and wrapper command tests,
- VS Code extension packaging and smoke test,
- release workflow producing provenance, signatures, and SBOM,
- docs labels generated from release evidence rather than hand-written status badges.

## Validation Performed

- `npm pack --dry-run --json` for repo root, Node SDK, legacy MCP package, and VS Code package.
- `npm view @kolm/cli version --json` returned 404.
- `npm view @kolmogorov/kolm-sdk version --json` returned 404.
- `npm view kolmogorov-stack version --json` returned 404.
- `pip index versions kolm` showed an unrelated PyPI package at version 1.1.4.
- PyPI JSON metadata for `kolm` confirmed unrelated summary, author, and homepage.
- GitHub checks for documented Homebrew tap, winget path, and Scoop manifest returned 404.
- `node --check` passed for Node SDK, legacy MCP server, and VS Code extension source files.
- Python SDK source files passed `py_compile` under the available system Python.
- Local CLI probes confirmed `whoami` and `verify` are unknown root commands.
