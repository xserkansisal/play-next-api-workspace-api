# Team activity history: frontend integration

The team activity history is a durable, newest-first timeline of successful shared-content
changes. It answers **who changed what and when**; it is separate from both the administrator
audit log and the per-resource version history.

## Endpoint and access

| Method | Route | Team context | Result |
| --- | --- | --- | --- |
| `GET` | `/api/v1/activity?limit=50&cursor=...` | Required; send `X-Team-Id` | `{ entries: ActivityEntry[], nextCursor: string \| null }` |

The usual signed-in session is required. Every team member, including viewers, can read activity
for the selected team. A caller without access to the selected team receives the usual
`404 TEAM_NOT_FOUND`; a missing team context follows the standard team middleware behavior.
Activity from another team is never returned.

`limit` is optional, defaults to `50`, and must be between `1` and `100`. `cursor` is an opaque
value returned as `nextCursor`; pass it unchanged to load the next page. Ordering is newest first,
with a stable ID tie-breaker. A `null` `nextCursor` means there are no more entries.

```ts
interface ActivityEntry {
  id: string;
  actor: string; // Email captured when the activity was written
  action: string;
  resourceType: "collection" | "folder" | "request" | "environment" | "variable";
  resourceId: string;
  resourceName: string; // Name captured at the time of the event
  collectionId: string | null;
  details: Record<string, unknown>;
  createdAt: string; // ISO-8601 UTC
}
```

Example:

```json
{
  "entries": [
    {
      "id": "4aed77ac-c4ba-4f9e-a20b-4ad37936d974",
      "actor": "alex@example.com",
      "action": "item.updated",
      "resourceType": "request",
      "resourceId": "83e6f4fc-bfba-4a06-99b0-9fc721c15d54",
      "resourceName": "Create order",
      "collectionId": "84fc9355-2bc1-4318-bf19-92948120a653",
      "details": {
        "changedFields": [
          "name",
          "description",
          "method",
          "url",
          "queryParams",
          "headers",
          "body",
          "auth",
          "preRequestScript",
          "postResponseScript"
        ]
      },
      "createdAt": "2026-10-03T06:15:00.000Z"
    }
  ],
  "nextCursor": null
}
```

## Recorded changes

| Action | Meaning and common safe details |
| --- | --- |
| `collection.created` | New collection; `itemCount` when the collection was created with an initial tree |
| `collection.updated` | Collection metadata changed; `changedFields` contains field names only |
| `collection.version_restored` | A collection metadata version was restored; `changedFields` lists metadata fields |
| `collection.cloned` | New collection copied; `sourceCollectionId`, `itemCount` |
| `collection.trashed` / `collection.restored` | Collection moved to/from Trash; restore includes `restoredItemCount` and `renamedItemCount` |
| `collection.imported` | Items imported into a collection; `parentId`, `folders`, `requests`, `renamedFolders` |
| `collection.openapi_synced` | OpenAPI sync applied; `added`, `adopted`, `updated`, `moved`, `deleted`, `recreated`, `pendingCount` |
| `item.created` / `item.updated` | Folder or request created/updated; update details list changed field names only |
| `item.version_restored` | Folder/request version restored; details list the fields restored |
| `item.cloned` | New folder/request copied; `sourceItemId`, `subtreeItemCount` |
| `item.moved` | Folder/request moved; source/target collection IDs and target parent ID |
| `item.trashed` / `item.restored` | Item root moved to/from Trash; subtree counts are included, not one event per descendant |
| `environment.created` / `environment.updated` | Environment created/saved; update details include changed fields and `variableCount` |
| `environment.variable_added` | A variable row was appended; `variableKey` is included, never its value |
| `environment.cloned` | Environment copied; `sourceEnvironmentId`, `variableCount` |
| `environment.trashed` / `environment.restored` | Environment moved to/from Trash |
| `variable.created` / `variable.updated` / `variable.renamed` / `variable.deleted` | Shared (`global`) team variable changed; its key may be shown, but its value is never recorded |

The API adds activity only after a successful write. Failed validations, conflicts, and import
dry-runs do not create activity entries. Bulk imports, OpenAPI sync, and Trash operations produce
one summary event per user action rather than one event per affected child.

## Privacy and retention

Activity details intentionally do **not** contain request URLs, query/header values, bodies, auth
secrets, scripts, environment variable values, or shared variable values. `changedFields` contains
field names, not before/after values. Collection, request, folder, environment, and variable names
are stored as display snapshots so the timeline remains readable after a resource is renamed or
deleted. The actor email is also captured at write time so it remains attributable if the account
is later removed.

Entries are persisted in the same database transaction as the content change. A rolled-back
content change therefore cannot leave an activity entry behind. There is currently no automatic
retention expiry or delete endpoint.

This timeline is different from:

- `GET /api/v1/admin/audit-log`, which is a system-admin-only log for administrative team/user
  management.
- Collection/item `versions` endpoints, which hold restorable snapshots of editable content.
- `GET /api/v1/events`, which is an ephemeral live notification stream and is not an activity
  history.

## Suggested frontend behavior

- Load the first page after opening the selected team's activity panel. Include `X-Team-Id` on
  every request.
- Render `actor`, a localized label for `action`, `resourceName`, and `createdAt`. Use
  `resourceType` and `collectionId` to build a link when the referenced resource still exists.
- Treat resource IDs and names as historical snapshots; a deleted resource may no longer open.
- Use `nextCursor` for a “load more”/infinite-scroll interaction and do not manufacture cursor
  values. On team switch, discard the old team's activity pages and start without a cursor.
- Do not interpret `details` as content diffs. Render only known safe counts, field names, and
  IDs; never expose API credentials or content values from another endpoint as activity details.
- Handle `400 ACTIVITY_CURSOR_INVALID` by dropping the cursor and reloading from the first page.
