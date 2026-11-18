# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node CLI that reads C2PA Content Credentials from Amplience DAM assets, classifies each as `fullyGenerated` / `partiallyModified` / `none` / `unknown`, writes the verdict to a metadata field, and publishes it so Dynamic Media can render an EU AI Act label. It runs on a schedule as an Amplience processing job. README.md is long and is the authoritative record of verified API behaviour; read the relevant section before changing anything that talks to the DAM.

## Commands

```bash
npm run setup                      # npm install + fix native binary (required on macOS/Windows)
npm run fix-binary                 # re-fetch the host-correct c2pa-node binary
npm test                           # node --test test/*.test.js
node --test test/classify.test.js  # single file
node --test --test-name-pattern "composite" test/classify.test.js  # single test
node bin/c2pa-disclosure.js --help
```

No build step, linter or TypeScript. Plain CommonJS, `'use strict'`, Node's built-in `node:test` and `node:assert`.

## Hard constraints from the runtime

- **Node 16 floor.** Don't use syntax or APIs newer than Node 16. `@contentauth/c2pa-node` declares `>=22`, but that isn't a real requirement (see README).
- **`vm.runInNewContext` sandbox.** The job runner executes `main` (`bin/c2pa-disclosure.js`, which must stay the CLI) inside a vm context. That rules out dynamic `import()` (no module loader), `child_process`, `vm`, `process.cwd()` and `process.chdir()`. Resolve paths from `__dirname` and load code with `require`.
- **`.npmrc` sets `ignore-scripts=true` deliberately.** Don't move setup into a `postinstall`, because the runner skips root lifecycle scripts and dependency scripts crash under its old system Node.
- **The runner splits `args` on spaces with no quote handling.** That's why `--query-b64` exists and why unknown `--flags` are rejected (the `KNOWN` set in `bin/c2pa-disclosure.js`). A new flag must be added to `KNOWN` and to `HELP`.
- Nothing is read from env except `AMP_SESSION_TOKEN` (base64 bearer token set by the runner). `--token` overrides it.

## Architecture

`bin/c2pa-disclosure.js` parses and validates args (sort validation, duration parsing, query decoding), resolves auth, picks a reader, calls `run()`, and prints the summary report, including the `NON-STANDARD digitalSourceType LOCATIONS` and `NO SOURCE TYPE FOUND` diagnostics.

`lib/run.js` `run(opts)` orchestrates the work. It takes an injected `client` and `Reader`, so tests drive it with fakes. Per asset:
1. Preflight: fetch asset detail and existing metadata **before** downloading, because the download is the expensive step. Skip inactive assets. Skip assets already analysed, either by version (`--version-field` ≥ `revisionNumber`) or by an existing value.
2. Download the **original** bytes (Dynamic Media renders strip metadata), read the manifest, then `classify()`.
3. Attach the schema **only if it isn't attached yet**, then write the value and the version.
4. At the end, publish only assets that were written, whose verdict changed (in versioned mode), **and that were already published**. The tool never publishes a previously unpublished asset.

Revision semantics drive most of the logic in steps 3–4. `attachMetadataSchema` (PUT /assets) bumps the revision on every call, `publishAssets` bumps it too, and `writeMetadata` does not. Get any of these wrong and the recorded version never catches up, so every asset is re-downloaded forever. `test/run-version.test.js` has a `fakeClient` that models exactly this; keep it faithful.

`lib/classify.js` is pure: a manifest store goes in, `{ disclosure, evidence }` comes out. It holds all the decision logic. Key rules:
- A missing or unvalidatable manifest yields `unknown`, never `none`.
- Ambiguity must resolve toward "AI", because a false negative is the failure that must not happen.
- `digitalSourceType` is read from the spec location first, then from vendor params matched by key shape (`*.digitalSourceType`, e.g. Adobe Firefly's `com.adobe.digitalSourceType`).
- Both `composite` and `composited` spellings are accepted.

`lib/reader.js` `getReader()` returns `{ Reader, verifies, why }`, trying these in order:
1. `NativeReader`, which `require`s `@contentauth/c2pa-node/dist/index.node` directly, because the package is ESM-only and `import()` fails in the vm.
2. The ESM package.
3. `JsReader`, a pure-JS fallback built on `lib/manifest.js` + `lib/cbor.js` (JUMBF extraction from PNG/JPEG/WebP plus a minimal CBOR decoder). It does **not** verify signatures, and its results are reported as UNVERIFIED.

The job runner's glibc is too old for the native addon, so in production the fallback is the expected path. `--require-verification` makes that a hard failure. Upstream `FileAsset` (`{ path }`) is broken; always pass `{ buffer, mimeType }`.

`lib/amplience.js` `AmplienceClient` wraps the DAM API with axios, retrying on 429/5xx. `assetMetadata()` returns values keyed by schema, plus a `SCHEMA_IDS` symbol property holding the set of attached schema ids.

## Gotchas that fail silently

- Trust settings must be the PEM **contents**, not file paths (`buildSettings` in `lib/run.js`). A path neither works nor errors: validation stays at `Valid` + `signingCredential.untrusted`.
- The metadata schema is addressed by two UUIDs. `--schema-name` attaches it and `--schema-id` writes values. Swapping them fails quietly.
- Trust lists are vendored with dated filenames under `lib/trust/`. Defaults are hard-coded in `bin/c2pa-disclosure.js` (`DEFAULT_ANCHORS`, `DEFAULT_ALLOWED`); update them when refreshing.
- `--since` relies on the default `updated:desc` order to stop early, so it can't be combined with `--sort`.
- An account-wide run (no `--bucket`) lists the buckets in scope and refuses to run if there are none, because the API returns 200 with an empty page for a user with no bucket access.
- Query syntax quirks (square-bracket ranges, no `NOT`, a negated metadata term can't come first inside parentheses) are covered in README and in `docs/asset-query-reference.md`.

## Releases

Jobs pin `remoteuri` to `https://github.com/ncooper-amp/c2pa-disclosure#vX.Y.Z`. A release means bumping `version` in `package.json`, updating the tag in the README job-config example, and tagging.
