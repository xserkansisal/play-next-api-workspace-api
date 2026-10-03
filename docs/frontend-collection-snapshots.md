# Collection snapshots: frontend API guide

Collection snapshots capture a collection's metadata and its complete active folder/request tree
as one revision. The frontend can browse snapshots, compare one with another (or with the live
collection), and restore one atomically.

## Access and common behavior

All endpoints are under `/api/v1/collections/:collectionId` and require the signed-in session and
team context (`X-Team-Id`, unless the user's only team is selected automatically). Reads are
available to team members, including viewers. Restore requires the `member` role or higher. Only
active collections are available; a missing, deleted, or inaccessible collection returns `404`.
Send credentials with the session cookie as for other API calls.

Snapshot records include request and folder auth configuration, including credentials. Treat
snapshot detail and diff responses as sensitive collection data. Snapshots exclude trashed items,
effective/inherited auth, timestamps, and authorship fields on individual items.

## Endpoints

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/collections/:collectionId/snapshots` | List snapshot metadata |
| `GET` | `/api/v1/collections/:collectionId/snapshots/:snapshotId` | Fetch a full snapshot |
| `GET` | `/api/v1/collections/:collectionId/snapshots/diff?from=:snapshotId&to=:snapshotId\|current` | Compare snapshots |
| `POST` | `/api/v1/collections/:collectionId/snapshots/:snapshotId/restore` | Restore a snapshot |

### List snapshots

`GET /api/v1/collections/:collectionId/snapshots?limit=25&offset=0`

Returns newest first:

```json
{
  "snapshots": [
    {
      "id": "snapshot-uuid",
      "itemCount": 3,
      "createdAt": "2026-10-03T09:00:00.000Z",
      "createdBy": "user@example.com"
    }
  ],
  "nextOffset": null
}
```

`limit` defaults to 25 and must be 1–100. `offset` defaults to 0. Request the returned
`nextOffset` for the next page; `null` means there are no more results. `createdBy` is the author's
email, or `null` if unavailable.

### Fetch a snapshot

`GET /api/v1/collections/:collectionId/snapshots/:snapshotId`

Returns `{ id, snapshot, itemCount, createdAt, createdBy }`. `snapshot` contains collection
metadata and a nested active tree:

```json
{
  "id": "snapshot-uuid",
  "snapshot": {
    "name": "Payments",
    "description": "Payment API",
    "auth": null,
    "items": [
      {
        "id": "folder-uuid",
        "type": "folder",
        "name": "Checkout",
        "description": "",
        "auth": null,
        "items": [
          {
            "id": "request-uuid",
            "type": "request",
            "name": "Create payment",
            "description": "",
            "method": "POST",
            "url": "/payments",
            "queryParams": [],
            "headers": [],
            "body": null,
            "auth": { "type": "inherit" },
            "preRequestScript": "",
            "postResponseScript": ""
          }
        ]
      }
    ]
  },
  "itemCount": 2,
  "createdAt": "2026-10-03T09:00:00.000Z",
  "createdBy": "user@example.com"
}
```

Folder items have `id`, `type`, `name`, `description`, `auth`, and nested `items`. Request items
have `id`, `type`, `name`, `description`, `method`, `url`, `queryParams`, `headers`, `body`, `auth`,
`preRequestScript`, and `postResponseScript`. Item IDs are stable identities used for matching
items across revisions. Parent relationships are represented by nesting; item timestamps,
attribution, and `effectiveAuth` are not included.

### Compare snapshots

`GET /api/v1/collections/:collectionId/snapshots/diff?from=:snapshotId&to=:snapshotId`

Both IDs must belong to this collection. To compare a saved snapshot with the current active
collection, set `to=current`. The `from` parameter must always be a snapshot UUID.

The response contains:

```json
{
  "from": { "id": "snapshot-a", "name": "Payments", "description": "", "auth": null },
  "to": { "id": "current", "name": "Payments API", "description": "", "auth": null },
  "collectionFields": ["name"],
  "items": {
    "added": [{ "id": "new-item-uuid", "path": ["Checkout", "Refund"], "node": {} }],
    "removed": [{ "id": "old-item-uuid", "path": ["Legacy"], "node": {} }],
    "moved": [{
      "id": "request-uuid",
      "fromParentId": "old-folder-uuid",
      "toParentId": "new-folder-uuid",
      "fromPath": ["Old", "Request"],
      "toPath": ["New", "Request"]
    }],
    "changed": [{
      "id": "request-uuid",
      "fields": ["url"],
      "before": { "type": "request", "url": "/old" },
      "after": { "type": "request", "url": "/new" }
    }]
  }
}
```

`collectionFields` names changed collection metadata fields (`name`, `description`, `auth`).
`added` and `removed` contain `{ id, path, node }`; `moved` reports changed parent IDs and paths;
`changed` reports editable field names with before/after values. Diff identity is based on item ID:
a delete-and-recreate with a new ID is reported as removal plus addition, not as an edit. Folder
rename is a changed `name` field; moving an item is reported separately. Folder nodes include their
nested children, so a folder entry's `node` contains its subtree as well as the individual item
entries in the diff arrays.

### Restore a snapshot

`POST /api/v1/collections/:collectionId/snapshots/:snapshotId/restore`

Send an empty body. On success, the endpoint returns the regular `CollectionAggregate` (collection
metadata, auth, and current nested items) and publishes a collection `updated` event. Replace the
client's cached collection with this response, then refresh snapshot history.

Restore is atomic:

- It restores the snapshot's collection metadata and active tree.
- Existing items in the same collection are matched by ID; matching trashed items are reactivated.
- Current active items absent from the selected snapshot are moved to Trash.
- It does not implicitly move an item back from a different collection.
- It records the current state as a new snapshot before applying the restore, so restore itself can
  be undone by restoring that new snapshot.

Possible errors include:

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | Invalid query parameters |
| `403` | `TEAM_ROLE_REQUIRED` | Restore attempted by a viewer |
| `404` | `NOT_FOUND` | Collection or snapshot is missing, inactive, or belongs to another collection |
| `409` | `COLLECTION_NAME_CONFLICT` | The snapshot's collection name is already used by another active collection |
| `409` | `SNAPSHOT_ITEM_MOVED` | An item in the snapshot now belongs to another collection; `details.itemIds` identifies it |
| `409` | `SNAPSHOT_ITEM_TYPE_CONFLICT` | A stored item ID has a different type from the snapshot |

Show a confirmation before restore and handle conflicts without assuming any part of the operation
was applied.

## When snapshots are created

No initial snapshot is created when a collection is created. A snapshot is taken immediately before
each successful collection metadata update/restore, item create/update/clone/trash/restore, import,
OpenAPI sync apply, or collection trash. A move records the source collection and, for a cross-
collection move, the target collection. A snapshot restore also snapshots the state it replaces.
Dry runs and failed operations do not create snapshots. History is retained without automatic
expiry.

Use these endpoints for whole-tree history. The existing `/versions` endpoints remain separate and
continue to serve collection-metadata-only and single-item history.
