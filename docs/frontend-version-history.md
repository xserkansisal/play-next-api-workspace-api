# Version history: frontend integration

Version history is available for collection metadata and for an individual folder or request.
It does not capture a whole collection tree as a single revision.

## Endpoints

| Method | Route | Result |
| --- | --- | --- |
| `GET` | `/api/v1/collections/:collectionId/versions` | List prior collection metadata |
| `POST` | `/api/v1/collections/:collectionId/versions/:versionId/restore` | Restore collection metadata |
| `GET` | `/api/v1/collections/:collectionId/items/:itemId/versions` | List prior fields of one folder or request |
| `POST` | `/api/v1/collections/:collectionId/items/:itemId/versions/:versionId/restore` | Restore that folder or request's fields |

All routes require the usual signed-in session. Collection and item IDs must refer to active
resources. A version belonging to a different collection or item is not visible and returns `404`.

## Listing versions

The response is an array wrapper, newest first:

```json
{
  "versions": [
    {
      "id": "version-uuid",
      "snapshot": {
        "name": "Previous name",
        "description": "Previous description",
        "auth": null
      },
      "createdAt": "2026-10-02T00:00:00.000Z",
      "createdBy": "user@example.com"
    }
  ]
}
```

For item versions, `snapshot` has the saved item's own editable fields. A folder snapshot is
`{ "type": "folder", "name": string, "description": string, "auth": ScopedAuth | null }`. A request snapshot contains
`type: "request"`, `name`, `description`, `method`, `url`, `queryParams`, `headers`, `body`, and
`auth`, using the same field formats as the regular item read endpoint. Snapshots deliberately
exclude item identity, parent, timestamps, attribution, folder children, and collection contents.

A snapshot is recorded immediately before each successful collection or item `PUT`. Creating a
resource does not create an initial history entry. Soft deletion and moves do not create revisions.
History is retained without an automatic expiry.
Snapshots written before auth support may omit the `auth` property; treat an omitted legacy value as
`null` when restoring collection/folder settings.

## Restoring

Send a body-less `POST` to the restore route using the selected version ID. On success, the response
is the regular collection summary or item representation. Restore is atomic and uses the same name
conflict checks as a normal edit; a conflicting collection or folder name returns `409`.

The selected snapshot is applied to the current resource. Its ID, parent, children, and creation
metadata remain unchanged. Restoring a request replaces its method, URL, query parameters, headers,
body, and auth configuration. Restoring a folder changes its own name, description, and auth
setting.

Restore also records the state being replaced as a new version, so the resulting history remains
reversible. Clients can refresh the versions list after a restore to display that new entry.

## Suggested frontend behavior

- Offer history only for saved active resources, and use the matching collection/item history route.
- Show `createdAt` and `createdBy` alongside each snapshot; show or diff the snapshot before restore.
- Confirm before restoring, then replace the local resource with the returned response and refresh
  its version list.
- Handle `404` for deleted/missing resources or versions and `409` when restoring a name that now
  conflicts with another active resource.
