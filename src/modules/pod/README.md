# POD Generation Module

## Admin APIs

- `POST /admin/pod/generation/createBatch`: create a generation batch and prompt items.
- `POST /admin/pod/generation/runBatch`: run pending items in a batch.
- `POST /admin/pod/generation/retryFailed`: retry failed items in a batch.
- `POST /admin/pod/generation/retryItem`: retry one item.
- `GET /admin/pod/generation/detail`: get a batch with items.
- `POST /admin/pod/generation/items`: page items by batch.
- `/admin/pod/provider/*`: manage image and prompt provider configs.
- `GET /admin/pod/provider/options`: get enabled provider options for module settings.

Provider credentials and endpoints live in `pod_provider_config`. Module
settings select one image provider and one prompt provider, while shared
generation parameters such as image size, output size, timeout, temperature,
max tokens, and system prompt stay in module settings. A new batch uses the
selected image provider's concurrency setting. Request bodies and import rows
do not override image generation concurrency.
