'use strict';

// Minimal Amplience DAM client for the disclosure job.
//
// Auth is a bearer token supplied by the caller. The processing-jobs runner
// already executes as a user within a company, so there is no impersonation
// step here and no credential handling beyond an optional password grant for
// local testing.
//
// Read calls: asset search, asset detail, original bytes.
// Write calls: attach metadata schema, write metadata, publish.

const axios = require('axios');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRetryable = (status) => status === 429 || (typeof status === 'number' && status >= 500);

function describeError(err) {
  const status = err.response?.status ?? err.code ?? 'ERR';
  const body = err.response?.data;
  let message =
    body?.error ??
    body?.errors?.[0]?.developerMessage ??
    body?.errors?.[0]?.errorMessage ??
    body?.description ??
    err.message;
  if (typeof message !== 'string') message = JSON.stringify(message);
  return { status, message: String(message).slice(0, 300) };
}

// Non-enumerable key: callers iterate assetMetadata() by schema name, and an
// extra visible property would land in that iteration.
const SCHEMA_IDS = Symbol('schemaIDs');

class AmplienceClient {
  /**
   * @param {object} opts
   * @param {string} opts.token      bearer token
   * @param {string} [opts.damHost]  DAM API base, including version path
   * @param {function} [opts.log]
   */
  constructor({ token, damHost = 'https://dam-api.amplience.net/v1.5.0', log = () => {}, maxAttempts = 4 } = {}) {
    if (!token) throw new Error('a bearer token is required');
    this.token = token;
    this.damHost = damHost.replace(/\/+$/, '');
    this.log = log;
    this.maxAttempts = maxAttempts;
    this.stats = { gets: 0, writes: 0, retries: 0, bytes: 0 };
  }

  // Password grant, for local runs outside the jobs runner. The runner supplies
  // a token directly and never calls this.
  static async tokenFromPassword({ authHost, clientId, username, password }) {
    const res = await axios.post(`${authHost.replace(/\/+$/, '')}/oauth/token`, null, {
      params: { client_id: clientId, grant_type: 'password', username, password },
      timeout: 30000,
    });
    const token = res.data?.access_token;
    if (!token) throw new Error('token response had no access_token');
    return token;
  }

  async _request(config, { binary = false } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        this.stats[config.method === 'get' ? 'gets' : 'writes']++;
        const res = await axios({
          ...config,
          headers: { Authorization: `Bearer ${this.token}`, ...(config.headers ?? {}) },
          timeout: config.timeout ?? 60000,
          ...(binary ? { responseType: 'arraybuffer' } : {}),
        });
        return binary ? Buffer.from(res.data) : res.data;
      } catch (err) {
        lastErr = err;
        const { status } = describeError(err);
        if (!isRetryable(status) || attempt === this.maxAttempts) break;
        this.stats.retries++;
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
    const { status, message } = describeError(lastErr);
    const e = new Error(message);
    e.status = status;
    e.body = lastErr.response?.data;
    throw e;
  }

  get(url, opts) { return this._request({ method: 'get', url }, opts); }
  put(url, data) { return this._request({ method: 'put', url, data, headers: { 'Content-Type': 'application/json' } }); }
  post(url, data) { return this._request({ method: 'post', url, data, headers: { 'Content-Type': 'application/json' } }); }

  // ── Search ─────────────────────────────────────────────────────────────────
  //
  // Pagination is ?pageSize=N&start=M. `size`, `page`, `limit` and `count` are
  // silently IGNORED — they return 200 with the default 20 rows, so a wrong
  // param name looks like success.
  //
  // Results default to `updated` DESC (newest first). A `sort=field:asc|desc`
  // param is accepted — see docs/asset-query-reference.md — but note that
  // publishing bumps `updated`, so the default order puts assets this job just
  // published ahead of the unprocessed backlog.
  //
  // `query` is an opaque Lucene-style string passed through as `q`. See the
  // README for the forms that work; notably ranges need SQUARE brackets and
  // metadata is addressed as `<schemaKey>.<field>`.
  async *searchAssets({ bucket = null, query = null, sort = null, extra = null, pageSize = 100, limit = Infinity, status = 'active' } = {}) {
    let start = 0;
    let yielded = 0;
    let numFound = null;

    while (yielded < limit) {
      const params = new URLSearchParams();
      if (bucket) params.set('bucket', bucket);
      if (query) params.set('q', query);
      if (sort) params.set('sort', sort);
      params.set('pageSize', String(Math.min(pageSize, 1000)));
      params.set('start', String(start));
      const url = `${this.damHost}/assets?${params}${extra ? `&${extra}` : ''}`;

      const body = await this.get(url);
      const content = body?.content ?? {};
      const rows = content.data ?? [];
      if (numFound === null) numFound = content.numFound ?? rows.length;
      start += rows.length;

      for (const row of rows) {
        // Soft-deleted assets still list and still return bytes, but writing
        // metadata to one fails with "Request does not contain any metadata
        // linked to active assets".
        if (status && row.status !== status) continue;
        yield row;
        if (++yielded >= limit) return;
      }

      if (rows.length === 0 || start >= numFound) return;
    }
  }

  // Buckets the caller can READ. With no `bucket` parameter a search is scoped
  // to exactly this list, so it is also the answer to "what will an
  // account-wide run actually cover?".
  async buckets() {
    const body = await this.get(`${this.damHost}/buckets?pageSize=1000`);
    const rows = body?.content?.data ?? body?.content ?? [];
    return Array.isArray(rows) ? rows : [];
  }

  async assetCount({ bucket = null, query = null } = {}) {
    const params = new URLSearchParams();
    if (bucket) params.set('bucket', bucket);
    if (query) params.set('q', query);
    params.set('pageSize', '1');
    const body = await this.get(`${this.damHost}/assets?${params}`);
    return body?.content?.numFound ?? 0;
  }

  async asset(assetId) {
    const body = await this.get(`${this.damHost}/assets/${assetId}`);
    return body?.content?.data?.[0] ?? body?.content ?? body;
  }

  // Values currently stored against an asset, keyed by schema name. The set of
  // schema IDs is carried alongside on a non-enumerable property, because
  // attaching a schema that is already attached is not free — see
  // attachMetadataSchema.
  async assetMetadata(assetId) {
    const body = await this.get(`${this.damHost}/assets/${assetId}/metadata`);
    const entries = body?.content?.metadata ?? body?.metadata ?? [];
    const out = {};
    for (const e of entries) out[e.schema] = e.variants?.[0]?.values ?? {};
    Object.defineProperty(out, SCHEMA_IDS, {
      value: new Set(entries.map((e) => e.schemaID).filter(Boolean)),
      enumerable: false,
    });
    return out;
  }

  // ── Original bytes ─────────────────────────────────────────────────────────
  //
  // NOT a Dynamic Media render: DI strips metadata during transformation, so
  // provenance has to come from the ingested original.
  //
  // Two steps, and the first does not return the file. GET /download responds
  // with {content: "/assets/{id}/download/handle?sig=..."} where sig decodes to
  // `assetId:expiryMs:hmac`. The signature is short-lived, so the handle cannot
  // be cached or precomputed.
  //
  // `reason` is recorded server-side (the Content Hub UI sends "n/a"). Downloads
  // appear in audit trails, so pass something that identifies the caller.
  async downloadOriginal(assetId, reason = 'c2pa-disclosure') {
    const step1 = await this.get(
      `${this.damHost}/assets/${assetId}/download` +
      `?X-AMP-CACHEBUST=${Date.now()}&reason=${encodeURIComponent(reason)}`);
    const handle = step1?.content;
    if (!handle) throw new Error(`no download handle for ${assetId} (status=${step1?.status ?? '?'})`);
    const buf = await this._request(
      { method: 'get', url: `${this.damHost}${handle}`, timeout: 120000 }, { binary: true });
    this.stats.bytes += buf.length;
    return buf;
  }

  // ── Metadata writes ────────────────────────────────────────────────────────
  //
  // Attaching a schema and writing values are separate calls that identify the
  // SAME schema by two DIFFERENT ids:
  //
  //   schemaName  used in relationships.add on PUT /assets
  //   schemaId    used in the "schema" field on PUT /metadata
  //
  // Both are UUIDs, neither is interchangeable, and using the wrong one fails
  // quietly. Until the attach runs, the write has nothing to write into.
  //
  // The attach is a PUT /assets, which **bumps the asset's revision every time
  // it is called** — even when the schema is already attached and nothing
  // changes. Writing metadata does not. Call this only when
  // assetMetadata()[SCHEMA_IDS] shows the schema is missing, or the revision
  // climbs by one on every run and any revision-based skip never settles.

  async attachMetadataSchema({ assetId, assetName, assetType = 'image', schemaName }) {
    return this.put(`${this.damHost}/assets`, {
      mode: 'overwrite',
      assets: [{
        id: assetId,
        type: assetType,
        name: assetName,
        relationships: { add: { [schemaName]: [{ id: assetId }] } },
      }],
    });
  }

  async writeMetadata({ assetId, schemaId, values, variantName = '*' }) {
    return this.put(`${this.damHost}/metadata`, [{
      schema: schemaId,
      PK: { id: assetId },
      variants: [{ variantName, values }],
    }]);
  }

  // Required after any change Dynamic Media has to see, INCLUDING a metadata
  // write. A value written but not republished is invisible to DI: expressions
  // referencing it resolve to empty rather than erroring.
  async publishAssets(assetIds) {
    return this.post(`${this.damHost}/assets/publish`, { assets: assetIds });
  }
}

module.exports = { AmplienceClient, SCHEMA_IDS, describeError };
