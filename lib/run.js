'use strict';

// Orchestration: find candidate assets, read their C2PA credentials, write the
// disclosure verdict back as metadata, publish.
//
// Designed to be run repeatedly on a schedule. Two independent guards make that
// safe:
//
//   1. The caller's query should exclude assets that already carry the field
//      (`-<schemaKey>.<field>:*`), so processed assets are never re-fetched.
//   2. Every asset is checked again before writing, so an overlapping or
//      re-run job still will not overwrite an existing value unless asked to.
//
// Guard 2 exists because guard 1 depends on a query the caller supplies and may
// get wrong. Downloading originals is the expensive step, so the check happens
// before the download, not after.

const fs = require('fs');
const pLimit = require('p-limit');
const { SCHEMA_IDS } = require('./amplience');

const { classify, validationSummary } = require('./classify');

// Reader.fromAsset returns null when an asset carries no manifest at all.
async function readManifest(Reader, buffer, mimeType, settings) {
  const reader = await Reader.fromAsset({ buffer, mimeType: mimeType || 'application/octet-stream' }, settings);
  if (!reader) return { store: null, isEmbedded: null, remoteUrl: null };
  return {
    store: reader.json(),
    isEmbedded: reader.isEmbedded(),
    remoteUrl: reader.remoteUrl() || null,
  };
}

// Trust settings must carry the PEM CONTENTS. The library documents a file path
// (`trustAnchors: 'path/to/anchors.pem'`) and passing one neither works nor
// errors: validation silently stays at `Valid` with `signingCredential.untrusted`,
// which reads exactly like "this signer is not on the trust list" — including
// for signers that are.
function buildSettings({ anchorsPath, allowedPath }) {
  const read = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  const anchors = read(anchorsPath);
  const allowed = read(allowedPath);
  if (!anchors) return { verify: { verify_trust: false } };
  return {
    trust: {
      verify_trust_list: true,
      trust_anchors: anchors,
      ...(allowed ? { allowed_list: allowed } : {}),
    },
    verify: { verify_trust: true },
  };
}

async function run(opts) {
  const {
    client, Reader,
    bucket = null, query = null, sort = null, limit = Infinity, since = null,
    schemaName, schemaId, field, versionField = null,
    concurrency = 4, dryRun = false, force = false,
    reason = 'c2pa-disclosure', publish = true,
    anchorsPath = null, allowedPath = null,
    log = () => {},
  } = opts;

  const settings = buildSettings({ anchorsPath, allowedPath });
  const trustEnabled = Boolean(settings.trust);
  if (!trustEnabled) log('  ! no trust anchors loaded — nothing can reach Trusted');

  // Collect candidates first. Under the default order results arrive
  // newest-first (`updated` DESC), so a `--since` window can stop as soon as it
  // passes the cutoff rather than paging the whole bucket. This is separate
  // from any `created:` clause in the query and works even where that field is
  // not indexed. A caller-supplied `sort` breaks that assumption, which is why
  // the CLI refuses the two together.
  const candidates = [];
  let stoppedEarly = false;
  for await (const row of client.searchAssets({ bucket, query, sort, limit: Infinity })) {
    if (since && typeof row.timestamp === 'number' && row.timestamp < since) { stoppedEarly = true; break; }
    candidates.push(row);
    if (candidates.length >= limit) break;
  }
  log(`  ${candidates.length} candidate asset(s)${stoppedEarly ? ' (stopped at --since cutoff)' : ''}`);

  const gate = pLimit(concurrency);
  const results = [];
  let done = 0;

  await Promise.all(candidates.map((row) => gate(async () => {
    const rec = {
      assetId: row.id, name: row.name, mimeType: row.mimeType,
      disclosure: null, validationState: null, failures: [], integrityFailure: false,
      claimGenerator: null, sourceTypes: [], sourceTypeVia: [], noSourceType: false, bytes: null,
      revision: row.revisionNumber ?? null, analysedVersion: null, previousDisclosure: null,
      wasPublished: null, action: 'pending', error: '',
    };

    try {
      // Preflight, before the download, because the download is the expensive
      // step and both of these can rule an asset out.
      //
      // The status re-check guards the gap between the search and the write.
      // Search already excludes deleted assets — the API applies a hardcoded
      // `!status:deleted` filter — but an asset deleted in between cannot be
      // written to, and finding that out after downloading it means having
      // paid for the bytes for nothing.
      // Metadata is read even under --force. Force means "re-analyse regardless
      // of the recorded version", not "pretend nothing is stored": the existing
      // values are still needed to know whether the schema is already attached
      // and whether the verdict actually changed. Skipping the read made a
      // forced run re-attach every asset and republish every one of them.
      const [detail, existing] = await Promise.all([
        client.asset(row.id),
        client.assetMetadata(row.id),
      ]);

      if (detail?.status && detail.status !== 'active') {
        rec.action = 'skipped-inactive';
        results.push(rec);
        return;
      }

      // Whether the asset is ALREADY live decides whether this job may publish
      // it. Unpublished assets are analysed — a customer can publish one at any
      // moment, and the label has to be in place before they do — but
      // publishing one here would put content live that its owner has not
      // released. PUBLISH_IN_PROGRESS and UNPUBLISH_IN_PROGRESS are both
      // transitional; leave them for the next run.
      rec.wasPublished = detail?.publishStatus === 'PUBLISHED';

      const values = Object.values(existing).find((v) => v && v[field] != null) ?? {};
      const current = values[field] != null && values[field] !== '' ? values[field] : null;
      rec.previousDisclosure = current;

      // Revision-aware skip.
      //
      // Without it, an asset can be classified once and then have its bytes
      // replaced: `created` does not move on overwrite and the field already
      // holds a value, so both the incremental query and this check skip it.
      // A clean asset labelled `none` can then be swapped for AI content and
      // never re-examined — an omission that looks like a pass.
      //
      // Comparing the stored analysis version against the asset's current
      // revision closes that: any new revision is re-analysed, whatever the
      // field already says.
      if (versionField) {
        const analysedAt = Number(values[versionField]);
        rec.analysedVersion = Number.isFinite(analysedAt) ? analysedAt : null;
        const rev = Number(row.revisionNumber);
        if (!force && Number.isFinite(analysedAt) && Number.isFinite(rev) && analysedAt >= rev) {
          rec.action = 'skipped-current';
          rec.disclosure = current;
          results.push(rec);
          return;
        }
      } else if (!force && current) {
        rec.action = 'skipped-existing';
        rec.disclosure = current;
        results.push(rec);
        return;
      }

      const buffer = await client.downloadOriginal(row.id, reason);
      rec.bytes = buffer.length;

      const { store, isEmbedded, remoteUrl } = await readManifest(Reader, buffer, row.mimeType, settings);
      const { disclosure, evidence } = classify(store);
      const v = validationSummary(store);

      Object.assign(rec, {
        disclosure,
        validationState: v.state,
        failures: v.failures,
        integrityFailure: v.integrityFailure,
        claimGenerator: evidence.claimGenerator,
        sourceTypes: evidence.sourceTypes,
        sourceTypeVia: evidence.sourceTypeVia ?? [],
        spellings: evidence.spellings,
        // A manifest that names a generator but yields no source type anywhere
        // is the shape that hid the Firefly vendor-parameter bug: credentials
        // present, verdict `none`, nothing obviously wrong. Flag it so a new
        // vendor placement surfaces as a question rather than a silent miss.
        noSourceType: Boolean(store) && evidence.sourceTypes.length === 0,
        isEmbedded, remoteUrl,
      });

      if (dryRun) { rec.action = 'dry-run'; results.push(rec); return; }

      // Attaching the schema is a PUT /assets, and it bumps the revision on
      // EVERY call — including when the schema is already attached and nothing
      // changes. Calling it unconditionally means the revision climbs by one
      // per run, always staying ahead of the version just recorded, so the skip
      // above never fires and every asset is re-downloaded forever. Attach only
      // when it is genuinely missing.
      let revision = Number(row.revisionNumber) || 0;
      const attached = existing[SCHEMA_IDS]?.has(schemaId);
      if (!attached) {
        await client.attachMetadataSchema({
          assetId: row.id, assetName: row.name, assetType: row.type ?? 'image', schemaName,
        });
        // Re-read rather than assuming the bump was exactly one, so the
        // recorded version matches the asset's actual state and the next run
        // skips instead of re-analysing.
        const after = await client.asset(row.id);
        revision = Number(after?.revisionNumber) || revision + 1;
        rec.schemaAttached = true;
      }
      rec.revision = revision;

      const payload = { [field]: disclosure };
      if (versionField) payload[versionField] = revision;
      await client.writeMetadata({ assetId: row.id, schemaId, values: payload });
      // Publishing is what makes a value visible to Dynamic Media — but it also
      // bumps the asset's revision, which the check above would then read as a
      // new revision needing re-analysis. Publishing only when the disclosure
      // actually changed breaks that loop: an unchanged verdict updates the
      // recorded version silently, and DI is already showing the right badge.
      rec.disclosureChanged = current !== disclosure;
      rec.action = 'written';
    } catch (err) {
      // Assets can be soft-deleted between the search and the write. The API
      // reports that as a generic 400, so name it: a stale worklist is an
      // ordinary condition on a scheduled job, not a fault to chase.
      const body = JSON.stringify(err.body ?? '');
      rec.action = body.includes('linked to active assets') ? 'skipped-inactive' : 'error';
      rec.error = `${err.status ?? 'ERR'}: ${String(err.message).slice(0, 160)}`;
    }

    results.push(rec);
    if (++done % 10 === 0) log(`  ${done}/${candidates.length}`);
  })));

  // Publish only what was actually written — DI cannot see unpublished values —
  // and only assets that were ALREADY live. An unpublished asset gets its
  // metadata written and left alone: publishing is the customer's decision, and
  // when they take it the disclosure value goes live with the image, verified
  // end to end. Publishing one here would release content on their behalf.
  const eligible = results.filter((r) => r.action === 'written' && (!versionField || r.disclosureChanged));
  const written = eligible.filter((r) => r.wasPublished).map((r) => r.assetId);
  const heldBack = eligible.length - written.length;
  if (heldBack) log(`  ${heldBack} unpublished asset(s) labelled but not published`);

  let published = 0;
  if (publish && written.length && !dryRun) {
    await client.publishAssets(written);
    published = written.length;
  }

  return { results, published, heldBack, candidates: candidates.length, stoppedEarly, trustEnabled };
}

module.exports = { run, buildSettings };
