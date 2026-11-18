# Amplience DAM asset query reference

What `?q=` on `/assets` can and cannot do, taken from the Solr schemas rather
than from trial and error, then verified against a live QA bucket.

Sources: `dam-db/solr-schemas/{assets,metadata}/managed-schema` for the fields,
`dam-api` `AssetsController.searchAssets` and `dam-db`
`indexaccess/model/AssetSearch` for the request handling.

There is no separate query language for processing jobs. A job is just a Node
script calling `GET /assets`, so everything below applies equally to both.

## Two cores

**Assets** — a fixed schema, 53 indexed fields, listed below. `uniqueKey` is `ID`.

**Metadata** — custom schemas live in a separate core keyed by `schemaID`, using
type-suffixed dynamic fields. The suffix encodes indexed/stored:

| Suffix | Type | Indexed | Stored |
|---|---|---|---|
| `*|s3` | string | yes | yes |
| `*|s2` | string | yes | no |
| `*|s1` | string | **no** | yes |
| `*|s0` | string | no | no |

Also `t` (text), `i` (int), `l` (long), `d` (double), `b` (boolean), `dt` (tdate),
`tp` (path), `c` (currency), `lonlat`.

This is why *"make the field searchable"* matters when defining a metadata
schema: a field declared non-searchable lands on `|s1`, is never indexed, and
**cannot be queried at all** — while still being perfectly readable through the
API. The failure looks like the field not existing.

Query metadata as `<schemaName>.<fieldName>`, e.g.
`versionedAiDisclosure.versionedAiDisclosure:*`. Indexed metadata is
denormalised into the assets core as `<schemaId>.<field>|<typeSuffix>`; the API
rewrites your friendly name into that before it reaches Solr, and only for
schemas the caller holds READ on. A name it cannot resolve is passed through
untouched, Solr rejects the undefined field, and you get a **500** — see the
remapping rules below.

## Indexed fields on the assets core

| Field | Type | Notes |
|---|---|---|
| `ID` | string | uniqueKey |
| `name`, `label`, `srcName` | string | also copied into the free-text `text` field |
| `type` | string | `image`, `text`, … — worth pinning, see below |
| `subType`, `mimeType` | string | |
| `bucketID`, `folder`, `folderPath`, `folderPathLbl` | string / path | `folderPath` supports descendant matching |
| `tags`, `tagsC` | string | multi-valued |
| `status` | string | **stale in the index** — see gotchas |
| `published` | boolean | |
| `publishStatus` | string | `PUBLISHED` etc. |
| `revisionNumber` | **int** | ranges work; bare equality does not |
| `created`, `updated` | **tdate** | the two that matter for scheduling |
| `locale`, `localeGroup`, `localeGroupIdentifier` | string | |
| `file`, `thumbFile`, `contents`, `joins` | string | |
| `lastPublish.{job,revNo,status,timestamp,errorCode}` | mixed | `revNo` is an int |
| `lastSuccess.{…}`, `lastUnpublish.{…}`, `lastUnpublishSuccess.{…}` | mixed | same shape |
| `workflow.{assignedAt,assignedBy,assignedTo,status}` | mixed | |
| `text`, `defString` | text | indexed, not stored; free-text targets |

## Parameters besides `q`

`AssetSearch.parse` recognises rather more than the docs suggest. Each has a
short and a long form; unrecognised parameters are ignored silently, which is
why a misspelling looks like success.

| Parameter | Alias | Effect |
|---|---|---|
| `q` | `query` | the main Lucene query |
| `bucket` | `b` | restrict to one bucket |
| `folder` | `f` | restrict to one folder |
| `pageSize` | `n` | rows; `0` returns counts only |
| `start` | `s` | offset |
| `sort` | — | `field:asc\|desc`, comma-separated, see below |
| `filter` | — | **replaces** the default filter queries, see below |
| `highlight` | `hl` | plus `hl.fl`, `hl.pre`, `hl.post`, `hl.max` |
| `snippetSize` | — | characters of context for text assets |
| `localeGroups.collapse` | `collapseLocaleGroups` | one row per locale group |
| `localeGroups.limit` | — | siblings returned per group (default 3) |
| `localeGroups.preferredLocales` | — | which sibling represents the group |
| `select` | — | `RequestSelection`; `highlighting` is honoured here too |

## Sorting

**Sorting works** — my earlier note that it 500s was wrong, and the cause was my
syntax. The API takes `field:direction` and splits on `:`; Solr's native
`sort=created desc` reaches it without a colon, so the whole string becomes the
field name and Solr rejects it as a 500.

```
sort=created:desc
sort=lastSuccess.timestamp:desc,ID:desc     # multiple keys, applied in order
sort=created                                # direction defaults to asc
```

Anything except `srcName` and `file` may be sorted on — those two are refused
with a clean 400 naming the field. Metadata fields **cannot** be sorted on:
`setSortFields` skips the schema-name remapping that `q` gets, so
`sort=versionedAiDisclosure.analysedVersion:desc` reaches Solr as an undefined
field and 500s. Sorting on a field without docValues (`revisionNumber`) works
fine.

The default is `updated:desc`, which is what puts anything the job just
published at the front of the next run's candidate list. `sort=updated:asc`
inverts that: the settle-cycle rows go to the back and a `--limit` spends
itself on the genuine backlog instead.

## The `filter` parameter

`filter` maps onto Solr's `fq`, takes a comma-separated list, and gets the same
schema-name remapping as `q`. Two reasons to care: Solr caches filter queries
independently of the main query, so the invariant clauses stay warm across
runs; and it keeps the interesting part of `q` readable.

**It replaces rather than adds.** The default list is:

```
!status:deleted
!3e491351-dd5f-4990-a1b4-0a4bbc13e1a7.hidden|b3:true
```

Passing any `filter` drops both. On a QA bucket showing 452 assets,
`filter=type:image` returned **157,529** — the soft-deleted rows from earlier
load-testing came flooding back. If you use `filter`, carry both defaults:

```
filter=!status:deleted,!3e491351-dd5f-4990-a1b4-0a4bbc13e1a7.hidden|b3:true,type:image,published:true
```

Bucket scoping is applied separately and survives the override, so this leaks
nothing across tenants — but it will happily hand you every deleted asset in
your own bucket.

## Deleted and hidden assets

`!status:deleted` is a **hardcoded filter query on every search**. Two
consequences that look like index bugs and are not:

- `status:deleted` always returns 0. The rows are removed by the `fq` before
  your query is scored, so you cannot ask for them through `q` at all.
- Deleted assets never appear in a default search, which is why the UI does not
  show them.

I previously recorded this as the search index being stale. It is not. Checked
three ways on a known-deleted asset: the search row says `deleted`, the detail
record says `deleted`, and a default search for its ID returns nothing.

The `hidden` flag comes from the system `fileAttributes` schema
(`3e491351-dd5f-4990-a1b4-0a4bbc13e1a7`), which also carries `system`. Both are
queryable by name — `fileAttributes.hidden:true`, `fileAttributes.system:true`
— and hidden assets are excluded by default alongside deleted ones. Nothing in
QA sets either.

It is tempting to mark the disclosure icons `hidden` so they drop out of the
candidate set without a name match. **Don't.** Hidden assets are absent from
search and from the UI, so a customer could no longer find them — and the icons
are exactly the kind of asset a customer will want to swap for their own
rendition. The EU publishes them, but nothing obliges a brand to use the
supplied artwork, and an overlay that cannot be replaced will not survive
contact with a design team. Excluding by name keeps them visible and editable.

## Syntax that works

| Goal | Form |
|---|---|
| Field present | `field:*` |
| Field absent | `-field:*` |
| Absent, inside an `OR` | `(*:* AND -field:*)` — must be anchored |
| Date range, relative | `created:[NOW -2HOUR TO *]` |
| Date range, rounded | `created:[NOW -7DAYS/DAY TO *]` |
| Date range, absolute | `created:[2026-08-02T00:00:00Z TO *]` |
| Int range | `revisionNumber:[10 TO *]` |
| Boolean | `published:true` |
| Exact string | `mimeType:image/png` |
| Prefix | `-name:eu-ai-icon*` |
| Boolean combination | `a:1 AND b:2`, `(a:1 OR b:2)` |

## Syntax that does not

| Attempt | Result | Why |
|---|---|---|
| `sort=created desc` | 500 | Solr's native form; the API wants `created:desc` |
| `sort=<schema>.<field>:desc` | 500 | sort keys skip the metadata remapping |
| `sort=srcName:asc` | 400 | explicitly forbidden, along with `file` |
| `NOT field:*` | 500 | use a leading `-` |
| `(-<schema>.<field>:* OR x)` | 500 | negated metadata term first inside a paren — see below |
| `created:[2026-08-02 TO *]` | 500 | dates need a full timestamp with `Z` |
| `revisionNumber:[NOW -1DAYS/DAY TO *]` | 500 | date maths against an int field |
| `revisionNumber:1` | 400 | bare int equality; use `[1 TO 1]` |
| Comparing two fields | — | not expressible; do it client-side |

## Metadata field remapping, and the one shape that breaks it

`QueryUtils.remapQueryFields` walks the query character by character. At each
`:` it scans backwards to the previous whitespace, and if what it finds contains
a `.` it treats the part before the dot as a schema name. One leading `-`, `(`
or `!` is stripped first. `lastPublish` and `lastSuccess` are special-cased,
since they contain dots but are ordinary fields.

Measured, all with the same metadata field:

| Query | Result |
|---|---|
| `-<m>:* AND type:image` | 441 |
| `!<m>:* AND type:image` | 441 |
| `(*:* AND -<m>:*)` | 446 |
| `(published:true AND -<m>:*)` | 27 |
| `(<m>:* AND published:true)` | 6 |
| `(-<m>:* AND published:true)` | **500** |
| `( -<m>:* AND published:true)` | **500** |

So: a **negated metadata term cannot be the first term inside a parenthesis**,
with or without a space after the paren. Everywhere else — leading the whole
query, following an operator, positive inside a paren — it is fine, and the same
shapes all work for ordinary asset fields. Hence the `(*:* AND -field:*)` anchor
in the production query; it exists to keep the negation off the paren, not
because Lucene dislikes leading negatives.

A schema name that cannot be resolved — misspelled, or one the caller has no
READ permission on — is left as-is and Solr rejects the undefined field. That is
a 500, not an empty result, so a permissions problem here is loud rather than
silent.

Bare terms with no field are rewritten to `(text:X OR defString:X)`, which is
how free-text search works.

## Gotchas worth knowing

**Results default to `updated` descending**, and publishing bumps `updated`. So
anything the job just published sorts to the top of the next run's candidate
list, ahead of an unprocessed backlog. With a `--limit` that halves effective
throughput — `sort=updated:asc` fixes it.

**`status` is not stale, and `status:deleted` is unaskable.** See the deleted
and hidden section above. The per-asset status re-check is still worth keeping,
but only as a guard against an asset being deleted between the search and the
write, not because the index lies.

**Metadata is not returned inline.** `select=meta:<schema>` adds a
`relationships` key but no values, so reading a metadata value costs a separate
`GET /assets/{id}/metadata`.

**`type:image` matters.** A bucket typically also holds `text` assets — the
accelerator HTML templates, for instance — and downloading one fails with
`type is unsupported`, which surfaces as a per-asset error rather than a skip.

## Filters that cut a candidate set hard

Measured on a QA bucket of 452 assets, applied cumulatively:

| Filter | Remaining |
|---|---|
| all assets | 452 |
| `type:image` | 447 |
| `AND published:true` | **32** |
| `AND` never analysed | 26 |
| `AND created:[2026-08-02… TO *]` | 22 |

**`published:true` is the big one, and it is safe.** An unpublished asset is not
served by Dynamic Media, so it carries no Article 50(4) exposure — nothing is
being shown to anyone. And because publishing bumps `updated`, the asset enters
the `updated:[NOW -2HOUR TO *]` clause the moment it becomes visible. Nothing is
missed; the work simply moves to the point where it starts to matter.

This is what makes the approach viable for very large libraries. A customer with
hundreds of millions of assets does not need them all classified — only the
published ones, and of those only the ones created since the Act applied, plus
whatever changes from now on.

## The production query

```
(((*:* AND -versionedAiDisclosure.versionedAiDisclosure:*)
    AND created:[2026-08-02T00:00:00Z TO *])
  OR updated:[NOW -2HOUR TO *])
 AND type:image AND published:true AND -name:eu-ai-icon*
```

Reading it clause by clause:

- **never analysed, created since the cutoff** — the bounded backlog. Content
  created before 2 August 2026 needs no retroactive labelling.
- **or updated in the last two hours** — deliberately *not* limited by creation
  date. A pre-cutoff asset overwritten with AI content today still needs a label,
  and this is the only clause that sees it.
- **published** — only what is actually being served.
- **type:image** — avoids `type is unsupported` errors on text assets.
- **not the overlay icons** — they live in the same bucket.

Pair it with `--version-field`, which re-analyses anything whose revision has
moved past the recorded one. The query is a shortlist; the version check is what
makes the result correct.
