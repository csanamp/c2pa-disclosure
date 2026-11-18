'use strict';

// Map a C2PA manifest store onto an AI-disclosure verdict.
//
// Pure: manifest JSON in, verdict out. No I/O, no library calls. This is the
// only part of the tool with real decision logic, so it is kept isolated and
// unit-tested.
//
// The four disclosure values line up with the three EU AI Act icon variants
// plus a review state:
//
//   fullyGenerated    -> "AI GENERATED" icon
//   partiallyModified -> "AI MODIFIED" icon
//   unknown           -> "AI" icon, needs human review
//   none              -> no icon
//
// `unknown` is deliberately distinct from `none`. An asset with no manifest has
// not asserted that it is human-made; it has asserted nothing. Under the AI Act
// marking grace period (to 2 December 2026) much genuinely AI-generated content
// still arrives unmarked, so collapsing absent into `none` would confidently
// mislabel exactly the assets the legislation targets.

// IPTC digital source type vocabulary. The composite term appears in the wild
// under two spellings — the C2PA spec guidance uses "composited", the CAI
// authoring docs use "composite". Match both: a silent miss here fails toward
// "not AI", which is the wrong direction to fail.
const DST = {
  TRAINED: 'trainedAlgorithmicMedia',
  COMPOSITE: ['compositedWithTrainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia'],
};

const DISCLOSURE = {
  FULLY: 'fullyGenerated',
  PARTIAL: 'partiallyModified',
  NONE: 'none',
  UNKNOWN: 'unknown',
};

// Actions that mean "this asset was brought into being", as opposed to edited.
const CREATION_ACTIONS = new Set(['c2pa.created', 'c2pa.opened']);

// Failure codes that mean the bytes no longer match what was signed, as opposed
// to codes that merely mean time has passed. Certificates expire while content
// stays intact — a 2022 camera sample reports Invalid purely because its signing
// certificate lapsed, with its content hash still matching. Treating every
// Invalid as tampering would quarantine authentic material, and increasingly so
// as certificates age.
const INTEGRITY_FAILURE = /dataHash|hashedURI|claimSignature\.mismatch|assertion\.(missing|undeclared)/i;

function sourceTypeLeaf(uri) {
  if (typeof uri !== 'string' || !uri) return null;
  const i = uri.lastIndexOf('/');
  return i >= 0 ? uri.slice(i + 1) : uri;
}

// Any parameter key that names a digital source type, whatever namespace it
// carries. Matches `digitalSourceType`, `com.adobe.digitalSourceType`, and the
// same pattern from any other vendor.
const VENDOR_SOURCE_TYPE_KEY = /(^|\.)digitalSourceType$/i;

// Resolve an action's digital source type.
//
// The spec puts it directly on the action. Real files do not always follow.
// Adobe Firefly, when routing to a third-party model, emits:
//
//   { "action": "c2pa.opened",
//     "parameters": { "com.adobe.digitalSourceType": ".../trainedAlgorithmicMedia",
//                     "com.adobe.modelId": "gemini-flash", ... } }
//
// with the standard field absent entirely. Reading only the spec location
// reports such an asset as `none` — a false negative on genuinely AI-generated
// content, which is the one direction this must never fail in. Observed on a
// real Firefly text-to-image export whose signature validates as Trusted.
//
// Vendor parameters are therefore consulted as a fallback, matched by key
// shape rather than by a hard-coded namespace, so other vendors doing the same
// thing are covered without another incident first.
function resolveSourceType(action) {
  if (action?.digitalSourceType) {
    return { leaf: sourceTypeLeaf(action.digitalSourceType), via: 'spec' };
  }
  const params = action?.parameters;
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (VENDOR_SOURCE_TYPE_KEY.test(key) && typeof value === 'string' && value) {
        return { leaf: sourceTypeLeaf(value), via: key };
      }
    }
  }
  return { leaf: null, via: null };
}

// Matches c2pa.actions, c2pa.actions.v2, and whatever comes next.
function isActionsLabel(label) {
  return typeof label === 'string' && label.split('.').slice(0, 2).join('.') === 'c2pa.actions';
}

// Every action across every manifest in the store, not just the active one. An
// AI-generated ingredient composited into an otherwise ordinary photo appears in
// the ingredient's manifest, and that still makes the result partial.
function collectActions(store) {
  const out = [];
  for (const [label, manifest] of Object.entries(store?.manifests ?? {})) {
    for (const assertion of manifest?.assertions ?? []) {
      if (!isActionsLabel(assertion?.label)) continue;
      for (const action of assertion?.data?.actions ?? []) {
        const { leaf, via } = resolveSourceType(action);
        out.push({
          manifest: label,
          isActive: label === store?.active_manifest,
          action: action?.action ?? null,
          sourceType: leaf,
          sourceTypeVia: via,
        });
      }
    }
  }
  return out;
}

/**
 * @param {object|null} store parsed C2PA manifest store, or null when absent
 * @returns {{disclosure: string, evidence: object}}
 */
function classify(store) {
  if (!store || !store.manifests || Object.keys(store.manifests).length === 0) {
    return {
      disclosure: DISCLOSURE.UNKNOWN,
      evidence: { reason: 'no manifest', actions: [], sourceTypes: [], spellings: [] },
    };
  }

  const actions = collectActions(store);
  const sourceTypes = [...new Set(actions.map((a) => a.sourceType).filter(Boolean))];
  const spellings = sourceTypes.filter((s) => DST.COMPOSITE.includes(s));

  const fullyGenerated = actions.some(
    (a) => a.sourceType === DST.TRAINED && CREATION_ACTIONS.has(a.action));
  const compositeAI = actions.some((a) => DST.COMPOSITE.includes(a.sourceType));
  const editedWithAI = actions.some(
    (a) => a.sourceType === DST.TRAINED && !CREATION_ACTIONS.has(a.action));

  let disclosure = DISCLOSURE.NONE;
  let reason = 'manifest present, no AI source type';
  if (fullyGenerated) {
    disclosure = DISCLOSURE.FULLY;
    reason = 'created as trainedAlgorithmicMedia';
  } else if (compositeAI || editedWithAI) {
    disclosure = DISCLOSURE.PARTIAL;
    reason = compositeAI ? 'composited with trained algorithmic media'
      : 'edited with trained algorithmic media';
  }

  const active = store.manifests[store.active_manifest];
  return {
    disclosure,
    evidence: {
      reason,
      claimGenerator: active?.claim_generator_info?.[0]?.name ?? active?.claim_generator ?? null,
      actions: actions.map((a) => `${a.action ?? '?'}${a.sourceType ? `:${a.sourceType}` : ''}`),
      sourceTypes,
      // Which location each source type came from. A value other than 'spec'
      // means a vendor put it somewhere non-standard and is worth knowing about.
      sourceTypeVia: [...new Set(actions.map((a) => a.sourceTypeVia).filter(Boolean))],
      spellings,
      manifestCount: Object.keys(store.manifests).length,
    },
  };
}

// c2pa-rs reports signature validity and certificate trust separately and
// exposes the combination as a single ValidationState: Invalid | Valid | Trusted.
//
//   Trusted  bytes intact AND the signer is on the configured trust list
//   Valid    bytes intact, signer not recognised  ("valid but untrusted")
//   Invalid  hash mismatch, broken signature, or an expired certificate
//
// Reported alongside the disclosure rather than folded into it: "this is AI" and
// "we can believe the thing telling us" are separate facts.
function validationSummary(store) {
  if (!store) return { state: 'NONE', failures: [], integrityFailure: false };
  const vr = store.validation_results?.activeManifest ?? {};
  const failures = [...new Set((vr.failure ?? []).map((f) => f.code).filter(Boolean))];
  return {
    state: store.validation_state ?? 'UNKNOWN',
    failures,
    integrityFailure: failures.some((f) => INTEGRITY_FAILURE.test(f)),
  };
}

module.exports = { classify, validationSummary, DISCLOSURE, DST, INTEGRITY_FAILURE };
