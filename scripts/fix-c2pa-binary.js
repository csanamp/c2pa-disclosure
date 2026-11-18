#!/usr/bin/env node
'use strict';

// Repair @contentauth/c2pa-node's native binary when its own postinstall
// installs the wrong platform build.
//
// Observed with 0.9.1 on Apple Silicon: the package ships a Linux x86-64 ELF
// into dist/index.node. The package's platform detection looks correct and the
// right asset is published on the GitHub release, so this is a packaging fault
// rather than a missing build.
//
// The failure is worth knowing about because the first symptom is misleading —
// requiring the module throws
//
//   TypeError: fs.stat is not a function
//
// from a JS fallback path, and only a direct call surfaces the real error:
//
//   dlopen(...index.node): tried: '...' (not a mach-o file)
//
// Idempotent: verifies the existing binary first and exits quietly if correct.
//
//   node scripts/fix-c2pa-binary.js [--force]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG = '@contentauth/c2pa-node';
const REPO = 'contentauth/c2pa-js';

const TARGETS = {
  'arm64:darwin': 'aarch64-apple-darwin',
  'x64:darwin': 'x86_64-apple-darwin',
  'arm64:linux': 'aarch64-unknown-linux-gnu',
  'x64:linux': 'x86_64-unknown-linux-gnu',
  'x64:win32': 'x86_64-pc-windows-msvc',
};

// What `file(1)` should say for each platform.
const EXPECT = { darwin: 'Mach-O', linux: 'ELF', win32: 'PE32' };

function main() {
  const force = process.argv.includes('--force');
  const key = `${os.arch()}:${os.platform()}`;
  const target = TARGETS[key];
  if (!target) { console.log(`c2pa: no known build for ${key}, leaving alone`); return; }

  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve(`${PKG}/package.json`, { paths: [process.cwd()] }));
  } catch (_) { return; }  // not installed — nothing to repair

  const binary = path.join(pkgDir, 'dist', 'index.node');
  if (!fs.existsSync(binary)) { console.log('c2pa: dist/index.node missing'); return; }

  const want = EXPECT[os.platform()];
  let described = '';
  try { described = execFileSync('file', ['-b', binary], { encoding: 'utf8' }).trim(); } catch (_) {}

  if (!force && want && described.includes(want)) return;  // already correct

  const version = require(path.join(pkgDir, 'package.json')).version;
  const url = `https://github.com/${REPO}/releases/download/${PKG}@${version}` +
              `/c2pa-node_${target}-v${version}.zip`;

  console.log(`c2pa: binary is "${described || 'unreadable'}", expected ${want}`);
  console.log(`c2pa: fetching ${target} build for v${version}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c2pa-fix-'));
  try {
    const zip = path.join(tmp, 'b.zip');
    execFileSync('curl', ['-sL', '--fail', '-o', zip, url], { stdio: 'inherit' });
    execFileSync('unzip', ['-o', '-q', zip, '-d', tmp]);

    const found = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'index.node') found.push(p);
      }
    })(tmp);
    if (!found.length) throw new Error('no index.node inside the release archive');

    fs.copyFileSync(found[0], binary);
    const now = execFileSync('file', ['-b', binary], { encoding: 'utf8' }).trim();
    if (want && !now.includes(want)) throw new Error(`replacement is still wrong: ${now}`);
    console.log(`c2pa: installed ${target} binary — ${now.slice(0, 60)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try { main(); } catch (e) {
  // Never fail the install: the audit script is optional tooling and a broken
  // binary should not block `npm install` for everyone else.
  console.error(`c2pa: could not repair binary — ${e.message}`);
  console.error('c2pa: scripts/c2pa-audit.js will not run until this is resolved');
}
