# POD Generation Module

## Admin APIs

- `POST /admin/pod/generation/createBatch`: create a generation batch and prompt items.
- `POST /admin/pod/generation/runBatch`: run pending items in a batch.
- `POST /admin/pod/generation/retryFailed`: retry failed items in a batch.
- `POST /admin/pod/generation/retryItem`: retry one item.
- `GET /admin/pod/generation/detail`: get a batch with items.
- `POST /admin/pod/generation/items`: page items by batch.

The default image provider is `mock`, which writes SVG placeholder images. Configure
`module.pod.generation.provider` and `endpoint` when a real image API is available.
