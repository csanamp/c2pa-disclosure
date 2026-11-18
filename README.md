# c2pa-disclosure

Classify Amplience DAM assets by AI provenance using [C2PA Content Credentials](https://c2pa.org),
and record the verdict as asset metadata so Dynamic Media can render an EU AI Act
disclosure label at delivery time.

Built to run on a schedule under Amplience processing jobs: every input is a
command-line argument, and re-runs skip assets that already carry a value.

```bash
c2pa-disclosure \
  --token "$TOKEN" \
  --bucket "$BUCKET" \
  --schema-name "$SCHEMA_NAME" --schema-id "$SCHEMA_ID" --field aiDisclosure \
  --query "-aiDisclosure.aiDisclosure:* AND -name:eu-ai-icon* AND created:[NOW -1HOUR TO *]"
```

## What it does

For each matching asset it downloads the **original** bytes — not a Dynamic Media
render, which strips metadata during transformation — reads any C2PA manifest,
and writes one of four values:

| Value | Meaning | EU icon |
|---|---|---|
| `fullyGenerated` | `c2pa.created` with `digitalSourceType: trainedAlgorithmicMedia` | "AI GENERATED" |
| `partiallyModified` | composited with, or edited by, trained algorithmic media | "AI MODIFIED" |
| `none` | manifest present, no AI source type | *(no icon)* |
| `unknown` | no manifest, or one that could not be validated | "AI" — needs review |

### digitalSourceType is not always where the spec puts it

The C2PA spec places `digitalSourceType` directly on the action. Adobe Firefly,
when routing to a third-party model, does not — it omits the standard field and
nests the value in a vendor-namespaced parameter:

```json
{ "action": "c2pa.opened",
  "parameters": {
    "com.adobe.digitalSourceType": "…/trainedAlgorithmicMedia",
    "com.adobe.modelId": "gemini-flash" } }
```

A classifier reading only the spec location reports such an asset as `none` — a
false negative on genuinely AI-generated content, and the one direction this
must never fail in. Observed on a real Firefly text-to-image export whose
signature validates as `Trusted`.

Vendor parameters are therefore consulted as a fallback, matched on key shape
(`*.digitalSourceType`) rather than a hard-coded namespace. The spec field wins
when both are present.

Two signals in the run summary exist so the next variant surfaces as a question
rather than a silent miss:

- **`NON-STANDARD digitalSourceType LOCATIONS`** — lists any key other than the
  spec field that supplied a value. Seeing `com.adobe.digitalSourceType` here is
  normal; seeing a new one is worth a look.
- **`NO SOURCE TYPE FOUND`** — assets carrying credentials and a named
  generator, but asserting no source type in any known location, grouped by
  generator. Usually genuine cameras. But this is exactly the shape the Firefly
  bug hid behind, so if a generator you expect to be generative appears here, it
  probably uses a placement this tool does not yet know.

`unknown` is deliberately distinct from `none`. An asset with no credentials has
not asserted that it is human-made; it has asserted nothing. Under the AI Act
marking grace period (to 2 December 2026) much genuinely AI-generated content
still arrives unmarked, so treating "absent" as "not AI" would confidently
mislabel exactly the assets the legislation targets.

Written values are published automatically — Dynamic Media cannot see metadata
that has not been republished.

## Install

Requires **Node 16+**.

```bash
npm run setup    # npm install, then fix the native binary for your platform
npm test
```

On Linux x64 a plain `npm install` is enough — see below.

### Why Node 16, when c2pa-node says 22

`@contentauth/c2pa-node` declares `engines: { node: ">=22" }`, but nothing in its
runtime path actually needs it:

| Component | Real requirement |
|---|---|
| Native addon (neon) | built against **`napi-6`** → Node 12.17+ |
| `fs-extra` | `>=14.14` |
| `@contentauth/c2pa-utilities`, `-types` | none declared |
| `pkg-dir` (`>=18`) | postinstall only — never imported at runtime |

N-API is ABI-stable and forward-compatible, so a `napi-6` addon keeps working on
every later Node. Verified by reading and validating a signed asset on Node
16.20.2: `Trusted`, same claim generator, same `digitalSourceType` as on 22.

The `>=22` appears to be a support-policy declaration rather than a technical
floor. `npm install` only warns about it unless you have `engine-strict=true`.
Node 16 is the tested floor here — not a recommendation to run an EOL runtime,
just a statement of what works if your job platform gives you no choice.

### Why this repo sets `ignore-scripts=true`

`.npmrc` disables dependency lifecycle scripts, and that is deliberate.

`@contentauth/c2pa-node` ships a **Linux x86-64** binary inside its npm tarball;
its postinstall exists only to swap that for a host-matching build. On Linux x64
the swap is a no-op — the shipped binary is already right.

It is also actively harmful on the Amplience job runner. There, npm runs under
Node 16, but the lifecycle script it spawns calls a bare `node`, which resolves
off `PATH` to a far older system Node that cannot parse the destructuring on
line 10 of its own postinstall:

```
npm ERR! const { stat, readFile } = require('node:fs/promises');
npm ERR! SyntaxError: Unexpected token {
npm ERR!     at Module._compile (module.js:439:25)     <- Node 0.10-era internals
```

Skipping scripts sidesteps that and keeps the correct binary. Verified: with
`.npmrc` present the install completes cleanly and `dist/index.node` remains the
Linux ELF.

**On macOS or Windows** the shipped binary is wrong for your host, so run
`npm run setup` (or `npm run fix-binary` after installing).
`scripts/fix-c2pa-binary.js` fetches the right build from the package's GitHub
release and is idempotent. The CLI also verifies the binary loads before doing
any work and points at that command if it cannot.

> Note that a project `.npmrc` is honoured even when npm is invoked as
> `npm install --prefix <dir>` from an unrelated working directory, which is how
> the job runner does it. The root package's own lifecycle scripts are *not* run
> in that mode — only dependencies' — which is why the fix lives in `.npmrc`
> rather than in a `postinstall`.

### An upstream bug worth knowing

> **`FileAsset` is broken.** Passing `{ path }` to `Reader.fromAsset` throws
> `TypeError: fs.stat is not a function` — an ESM/CJS interop fault in the
> package's own `assetSize.js`, unrelated to the binary and present even on a
> healthy install. Pass `{ buffer, mimeType }` instead, which this tool does.

## Authentication

The processing-jobs runner executes as a user within a company, so the tool takes
a bearer token and performs no impersonation:

```bash
--token "$TOKEN"
```

For local runs you can mint one with a password grant instead:

```bash
--auth-host https://auth.amplience.net \
--client-id "$CLIENT" --username "$USER" --password "$PASS"
```

Nothing is read from the environment and no credentials are ever written to disk.

## The schema

Values are written to a custom metadata schema you create once. Three things
about it are not obvious and cannot be changed later, because **metadata schemas
are immutable once created**:

1. **The schema id must not contain a hyphen.** Metadata is addressed in Dynamic
   Media expressions as `$this.metadata.<schemaId>.<field>`, and `-` parses as
   the subtraction operator, yielding `400 Invalid Expression`. Nothing escapes
   it — quoting parses but resolves empty; backticks and `%2D` both 400. Use
   `aidisclosure` or `ai_disclosure`, never `ai-disclosure`.
2. **Make the field searchable.** The incremental query below filters on
   `-<schemaKey>.<field>:*`, which only works if the field is indexed.
3. **Include an `unknown` value** in whatever vocabulary you define.

The same schema is then addressed by **two different UUIDs**, and they are not
interchangeable:

| Argument | Used for | API call |
|---|---|---|
| `--schema-name` | attaching the schema to an asset | `PUT /assets`, `relationships.add` |
| `--schema-id` | writing values | `PUT /metadata` |

Using the wrong one fails quietly rather than loudly.

## Selecting assets

`--query` is passed through to the DAM asset search as `?q=`. It is a
Lucene-style syntax; these forms are verified working:

| Goal | Query |
|---|---|
| Not yet classified | `-aiDisclosure.aiDisclosure:*` |
| Already classified | `aiDisclosure.aiDisclosure:*` |
| A specific value | `aiDisclosure.aiDisclosure:'fullyGenerated'` |
| Exclude operational assets | `-name:eu-ai-icon*` |
| Created in the last hour | `created:[NOW -1HOUR TO *]` |
| Created since yesterday | `created:[NOW -1DAYS/DAY TO *]` |
| Combined | `-aiDisclosure.aiDisclosure:* AND -name:eu-ai-icon* AND created:[NOW -1HOUR TO *]` |

Notes from testing:

- Ranges need **square** brackets. `created:(NOW -1HOUR TO *)` with parentheses
  parses but silently matches everything.
- Metadata is addressed as `<schemaKey>.<field>`, matching how it appears in
  `<asset>.json?metadata=true`.
- Negation is a leading `-`. `NOT field:*` returns a 500.
- A **negated metadata term cannot be the first term inside a parenthesis** —
  `(-aiDisclosure.aiDisclosure:* AND x)` returns a 500 where
  `(*:* AND -aiDisclosure.aiDisclosure:*)` is fine. Ordinary asset fields are
  unaffected. This is why the query above carries a `*:*` anchor.
- Deleted assets are excluded by the API itself, so `status:deleted` always
  matches nothing.

`--sort field:asc|desc` sets the order; the default is `updated:desc`. Metadata
fields cannot be sorted on, and `srcName` and `file` are refused outright.

`--since 90m|24h|7d` applies a client-side window on top, using the default
ordering and stopping as soon as it passes the cutoff. Useful where `created:`
is not indexed for your assets. It cannot be combined with `--sort`, which would
invalidate the early stop.

[`docs/asset-query-reference.md`](docs/asset-query-reference.md) has the full
picture: every indexed field, the parameters beyond `q`, and the shapes that
fail.

## Running as an Amplience processing job

The job clones this repository, runs `npm install`, and executes the file named
by `main` in `package.json` inside a `vm` sandbox.

Node 16 is enough — see [Why Node 16](#why-node-16-when-c2pa-node-says-22) if
your platform's runtimes are older than `@contentauth/c2pa-node`'s declared
`>=22` and you were about to give up on that basis.

### Job configuration

| Job argument | Value |
|---|---|
| `remoteuri` | `https://github.com/ncooper-amp/c2pa-disclosure#v0.10.0` |
| `args` | the CLI arguments, as one space-separated string |

**`remoteuri` must contain `#<tag>`.** The daemon splits on the `#` and checks
out whatever follows it; without one, validation rejects the job outright. Point
it at a release tag rather than a branch so a scheduled job cannot change
behaviour underneath you.

Example `args`, as one space-separated line:

```
--dam-host https://dam-api.amplience.net/v1.5.0
--query-b64 <base64 of the query below>
--schema-name <uuid> --schema-id <uuid>
--field versionedAiDisclosure --version-field analysedVersion
--sort updated:asc --limit 100
```

The query that goes in `--query-b64`:

```
(((*:* AND -versionedAiDisclosure.versionedAiDisclosure:*)
    AND created:[2026-08-02T00:00:00Z TO *])
  OR updated:[NOW -2HOUR TO *])
 AND type:image AND -name:eu-ai-icon*
```

Clause by clause: everything never classified and created since the Act
applied, **or** anything touched in the last two hours — the second clause
deliberately has no creation-date bound, because a pre-cutoff asset overwritten
with AI content today still needs a label. Then images only, and not the
overlay icons.

Note the query does **not** filter on `published:true`. It is tempting —
unpublished assets are not served by Dynamic Media, so they carry no immediate
exposure — but it leaves a hole. A customer publishing an asset between runs
would put it live unlabelled until the next run caught up.

Unpublished assets are therefore analysed like any other, and the tool **never
publishes an asset that was not already published**. The label is written and
left in place; when the customer publishes, by any route and at any time, the
disclosure value goes live with the image. Verified end to end: metadata written
before an asset's first publish renders correctly on that first publish.

Note there is no `--bucket`. Omitting it covers **every bucket the job's user
has READ on**, which is what an account needs — customers hold assets across
many buckets and move them between. Naming one is for scoped testing.

That scope follows the *user*, not the account. A bucket the job's user cannot
read is skipped, and a user with no bucket permissions at all gets a 200 with
an empty page — so the job would report success having examined nothing. The
tool therefore lists the buckets in scope on every account-wide run and refuses
to start if there are none. Check that line after adding a bucket.

`--sort updated:asc` matters once `--limit` is in play. The default order is
`updated:desc`, and this job publishes what it writes — so its own output sorts
to the front of the next run and the limit is spent re-reading settled assets.
Ascending puts them at the back.

### Use `--query-b64`, not `--query`

The runner splits `args` on spaces with no quote handling, so any value
containing a space is torn into separate argv entries — and a useful query
nearly always contains one. Encode it instead:

```bash
printf %s '-aidisclosure.aidisclosure:* AND -name:eu-ai-icon*' | base64
```

The tool round-trips the value and refuses anything that does not decode
cleanly, so a mis-encoded query fails immediately rather than silently
searching for nonsense.

### Authentication

No token argument is needed. The runner impersonates the configured user and
exposes the bearer token as `AMP_SESSION_TOKEN`, base64-encoded; the tool reads
and decodes it automatically. `--token` still wins if supplied, which is what
local runs use.

### Sandbox constraints

The script is executed with `vm.runInNewContext`, which blocks `child_process`
and `vm`, and makes `process.cwd()` and `process.chdir()` throw. This tool uses
none of them at runtime — paths resolve from `__dirname`.

**A vm context has no module loader, so dynamic `import()` fails outright:**

```
A dynamic import callback was not specified.
```

That rules out importing `@contentauth/c2pa-node`, which is ESM-only. `lib/reader.js`
therefore `require`s the native addon (`dist/index.node`) directly — it is an
ordinary CommonJS native module, and `require` *is* available in the sandbox —
and reimplements the few reader methods this tool uses. Upstream does the same
thing internally: its `binary.js` calls `createRequire(import.meta.url)` and
requires the same file. The ESM package is kept as a fallback for non-sandboxed
use.

Verified by running the CLI inside a `vm.runInNewContext` harness on Node 16,
with argv and `AMP_SESSION_TOKEN` shaped as the runner supplies them: assets
downloaded, credentials read, trust list applied, `Trusted` returned.

One further quirk worth knowing if you write your own job script: relative
`require`s work only because the wrapper reassigns `module.filename` to your
entry file before evaluating it. Without that they would resolve against the
wrapper's own directory.

## Running on a schedule

Filtering on `-<field>:*` is what makes the job safe to repeat: it selects only
unprocessed assets, so an hourly run picks up new uploads without touching
anything already classified. A time clause narrows it further but is not what
provides the guarantee.

There is a second, independent guard: every asset is re-checked immediately
before writing, so an overlapping run still will not overwrite an existing value.
Pass `--force` to deliberately reclassify.

Exclude operational assets — icons, watermarks, placeholders — that share a
bucket with content. During development this tool labelled its own overlay icons,
which produced a plausible-looking wrong answer rather than an error.

## Readers, and when signatures are not checked

Three readers are tried in order, strongest first. Each is probed with a real
asset before being accepted, so a library that loads but cannot run is skipped
rather than failing later against every asset in the sweep.

| Reader | Verifies signatures | Used when |
|---|---|---|
| Native addon (`require`) | yes | normal case |
| ESM package | yes | addon absent but package importable |
| **Pure JS** (`lib/manifest.js`) | **no** | native code cannot run at all |

The pure-JS reader exists for hosts whose C runtime is too old for the addon.
The Amplience job runner is one: its image is CentOS/RHEL 7 era (glibc ~2.17,
libstdc++ capped at `GLIBCXX_3.4.19`) while every published build of
`@contentauth/c2pa-node` needs glibc 2.34 and `GLIBCXX_3.4.29`. No release
targets an older toolchain, and the deprecated `c2pa-node` package builds from
source, which needs Rust on the host.

It parses the container (PNG `caBX`, JPEG `APP11`, WebP `C2PA`), walks the JUMBF
boxes, and decodes the CBOR assertions — reaching the same
`digitalSourceType` the native reader reports, so **the disclosure verdict is
identical**. Verified against every credentialled asset in a live bucket: 8 of
8 agree, across both PNG and JPEG.

What it cannot do is verify anything. No signature check, no trust list, no
tamper detection. Results are reported as `UNVERIFIED` and must never be
presented as verified provenance. The tool says so loudly on startup, and
`--require-verification` turns the downgrade into a hard failure for contexts
where unverified output is unacceptable.

Two implementation notes, both learned the hard way:

- **JPEG segments each repeat the box header.** A manifest over ~64KB is split
  across APP11 segments, and *every* packet carries LBox+TBox, not just the
  first. Concatenating them naively injects 8 spurious bytes per extra segment;
  the reassembled length is checked against the declared LBox to catch it.
- **The CBOR decoder is hand-written and dependency-free** (`lib/cbor.js`). The
  obvious choice, `cbor-x`, ships an optional *native* accelerator — precisely
  what this path exists to avoid. It is tested against the RFC 8949 vectors and
  cross-checked field-by-field against `cbor-x` on real manifests.

### Validation states

From `c2pa-rs`, when a verifying reader is in use:

| State | Meaning |
|---|---|
| `Trusted` | bytes intact **and** the signer is on the trust list |
| `Valid` | bytes intact, signer not recognised |
| `Invalid` | hash mismatch, broken signature, **or an expired certificate** |
| `UNVERIFIED` | pure-JS reader — nothing was checked |

That last point matters: `Invalid` does not imply tampering. A 2022 camera sample
reports `Invalid` purely because its signing certificate lapsed, with its content
hash still matching. The summary output splits integrity failures from everything
else for exactly this reason, and the split becomes more important as
certificates age.

The [official Content Authenticity trust list](https://verify.contentauthenticity.org/trust/anchors.pem)
is vendored under `lib/trust/` with a dated filename, so runs are reproducible
and need no network access to a third party. Refresh it with:

```bash
curl -sL -o lib/trust/anchors-$(date +%F).pem \
  https://verify.contentauthenticity.org/trust/anchors.pem
curl -sL -o lib/trust/allowed-$(date +%F).sha256.txt \
  https://verify.contentauthenticity.org/trust/allowed.sha256.txt
```

then point `--trust-anchors` / `--allowed-list` at the new files.

> **Trap:** the underlying library documents trust settings as file *paths*.
> Passing a path does not work and does not error — validation silently stays at
> `Valid` with `signingCredential.untrusted`, which reads exactly like "this
> signer is not trusted", including for signers that are. This tool reads the
> files itself and passes the PEM **contents**.

## Rendering the label

This tool only records the verdict. Rendering is a Dynamic Media transformation
template that reads the metadata and composites the matching EU icon.

Two constraints shape that template, both measured:

- `$this` inside a layer resolves to **that layer's** asset, not the base image.
  The base image is reachable as `$root.layer0.metadata.<schemaKey>.<field>`.
  `$root.metadata.*` looks equivalent and is not — it fails to resolve and DI
  then treats the layer as *visible*, showing a badge that should be hidden.
- Interpolating metadata into a layer's `src` returns HTTP 500, so the icon
  cannot be chosen by name. Declare one fixed-`src` layer per value and make
  exactly one visible.

```
v0=fullyGenerated&v1=partiallyModified&v2=unknown
&layer1=[src=/i//eu-ai-icon-fullyGenerated
        &w={$root.layer0.info.canvas.width*0.28}&right=24&bottom=24&anchor=BR
        &visible={($root.layer0.metadata.aidisclosure.aidisclosure==$v0)?1:0}]
&layer2=[… eu-ai-icon-partiallyModified … ==$v1 …]
&layer3=[… eu-ai-icon-unknown … ==$v2 …]
```

`none` needs no layer — rendering nothing is the correct output. The empty
account segment in `/i//` means the same template body works on any account
without edits.

The [official EU icons](https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content)
are free to use and need no attribution. Upload them once per account as
`eu-ai-icon-fullyGenerated`, `eu-ai-icon-partiallyModified` and
`eu-ai-icon-unknown`, and publish them.

Dynamic Media also **caches 404s**, so probing a URL before publishing poisons
that exact URL. Vary a parameter to get a clean read.

## Scope and status

Proof-of-concept quality: exercised against a QA account, not yet run at
production scale. The classification logic in `lib/classify.js` is pure and unit
tested; everything else is I/O against the DAM API.

Tested on Node 16.20.2 and 22.22.3, on macOS arm64, against a QA account. The
CLI has also been verified against a simulation of a job runner's argument
encoding and environment.

Not yet tested on Linux, which is what a job runner will actually use. The
native binary is per-platform, so that is the next thing to confirm — the
postinstall repair handles platform selection, but it has only been exercised
resolving Apple Silicon.

This is not legal advice. Whether a given asset requires disclosure under the EU
AI Act is a judgement for the publisher — the tool reports what an asset's
credentials assert, and the value it writes is only as good as the credentials it
finds.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
