#!/usr/bin/env python3
"""Native-runner spike driver. It does not claim cross-platform output."""
from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
from pathlib import Path

# Load only the adjacent stdlib-only validator, not a sys.path lookalike.
import importlib.util
_bundle_spec = importlib.util.spec_from_file_location('windows_bundle', Path(__file__).with_name('windows_bundle.py'))
assert _bundle_spec is not None and _bundle_spec.loader is not None
windows_bundle = importlib.util.module_from_spec(_bundle_spec)
_bundle_spec.loader.exec_module(windows_bundle)

ROOT = Path(__file__).resolve().parents[2]
WINDOWS_LOCK = Path(__file__).with_name('requirements-windows-x64.lock.txt')


def platform_key(system: str | None = None, machine: str | None = None) -> str:
    system = system or platform.system()
    machine = machine or platform.machine()
    normalized = machine.lower()
    if system == "Darwin" and normalized == "arm64":
        return "darwin-arm64"
    if system == "Windows" and normalized in {"amd64", "x86_64"}:
        return "win32-x64-cpu"
    raise ValueError(f"Unsupported native runtime build platform: {system}/{machine}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--bundle-sha256')
    parser.add_argument('--wheelhouse', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--prepared', type=Path)
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--darwin-wheelhouse', type=Path)
    parser.add_argument('--darwin-installation', type=Path)
    parser.add_argument('--darwin-mode', choices=['engineering','production'], default='production')
    args = parser.parse_args(argv)
    if args.prepare_only:
        if not all((args.bundle, args.bundle_sha256, args.wheelhouse, args.output)):
            raise ValueError('Explicit bundle, SHA256, wheelhouse and new output required')
        windows_bundle.prepare(args.bundle, args.bundle_sha256, args.wheelhouse, args.output, WINDOWS_LOCK)
        print('PREPARED_INPUT_BYTES_ONLY; native, model compatibility and legal clearance NOT_RUN')
        return 0
    key = platform_key()
    if key == 'win32-x64-cpu':
        if not all((args.bundle, args.bundle_sha256, args.wheelhouse, args.prepared)):
            raise ValueError('Windows requires explicit bundle, SHA256, wheelhouse and prepared input')
        windows_bundle.require_native()
        plan = windows_bundle.verify_prepared(args.bundle, args.bundle_sha256, args.wheelhouse, args.prepared, WINDOWS_LOCK)
        windows_bundle.verify_installed(plan)
        if args.dry_run or args.verify_only:
            print('ADMITTED_BUILD_INPUTS_ONLY; no build/native/model/legal success claimed')
            return 0
        if not args.output:
            raise ValueError('New caller-owned output required')
        output = args.output.absolute()
        windows_bundle.physical(output.parent, True)
        output.mkdir()
        spec_args = ['--bundle', str(args.bundle.absolute()), '--bundle-sha256', args.bundle_sha256,
                     '--wheelhouse', str(args.wheelhouse.absolute()), '--prepared', str(args.prepared.absolute())]
        command = [sys.executable, '-I', '-B', '-m', 'PyInstaller', '--distpath', str(output/'dist'),
                   '--workpath', str(output/'work'), str(Path(__file__).with_name('voice-runtime.spec')), '--', *spec_args]
        # Build-only offline settings. No runtime resource-root env or implicit downloads.
        import os
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
        env.pop('PYTHONPATH', None); env.pop('PYTHONHOME', None)
        env['PYINSTALLER_CONFIG_DIR'] = str(output/'pyinstaller-cache')
        subprocess.run(command, cwd=ROOT, env=env, check=True)
        # Recheck input bytes after the subprocess; never bless a changed staging tree.
        final_plan = windows_bundle.verify_prepared(args.bundle, args.bundle_sha256, args.wheelhouse, args.prepared, WINDOWS_LOCK)
        if final_plan != plan:
            raise ValueError('Build inputs changed during collection')
        report = windows_bundle.post_build(output/'dist/voice-runtime', plan)
        import json
        windows_bundle.write_new(output/'post-build.json', json.dumps(report, sort_keys=True, indent=2).encode()+b'\n')
        print('Candidate files verified; Windows clean-machine health/STT/TTS and rights remain mandatory.')
        return 0
    darwin_spec = importlib.util.spec_from_file_location('darwin_bundle',Path(__file__).with_name('darwin_bundle.py'))
    darwin = importlib.util.module_from_spec(darwin_spec); sys.modules['darwin_bundle']=darwin; darwin_spec.loader.exec_module(darwin)
    if not args.darwin_wheelhouse or not args.darwin_installation:
        raise ValueError('Darwin requires exact reviewed lock, wheelhouse and installed RECORD receipt')
    if args.dry_run or args.verify_only:
        darwin.require_native(); darwin.reviewed_source()
        darwin.plan(args.darwin_wheelhouse,args.darwin_installation,args.darwin_mode)
        print('DARWIN_INPUTS_VERIFIED_ONLY; no build, model or activation acceptance')
        return 0
    if not args.output: raise ValueError('New caller-owned Darwin output required')
    darwin.build(args.darwin_wheelhouse,args.darwin_installation,args.output,args.darwin_mode)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
