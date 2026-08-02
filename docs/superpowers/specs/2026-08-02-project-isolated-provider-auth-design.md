# Project-Isolated Provider Authentication Design

## Objective

Require pi-chat to receive provider authentication explicitly from the project process and prevent Pi from reading user-scoped provider credentials or model configuration.

## Scope

This change isolates only provider authentication and the model registry. Existing session storage, settings, resource loading, and other Pi state retain their current behavior.

## Configuration

Add the required environment variable `PI_PROVIDER_API_KEY`. It supplies the API key for the provider selected by `PI_MODEL`.

Startup must fail with a clear configuration error when `PI_PROVIDER_API_KEY` is absent or empty. The key must not be logged or persisted.

## Authentication and Model Registry

Create authentication storage with `AuthStorage.inMemory()`, then install `PI_PROVIDER_API_KEY` as a runtime override for the provider parsed from `PI_MODEL`.

Create the registry with `ModelRegistry.inMemory(authStorage)`. This exposes built-in models only and prevents loading `~/.pi/agent/models.json`.

Pass the same isolated `authStorage` and `modelRegistry` instances into every `createAgentSession()` call. This prevents session creation from constructing default user-scoped authentication or model services.

The resulting behavior must not read either:

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`

## Error Handling

Validate `PI_PROVIDER_API_KEY` during startup alongside the existing required configuration. Report only that the variable is required; never include its value in errors or logs.

Model lookup continues to reject unknown provider/model combinations. Because the registry is in memory, custom models from user configuration are intentionally unavailable.

## Documentation

Update `.env.example` with an empty `PI_PROVIDER_API_KEY` entry. Update the README configuration table and remove instructions requiring credentials in the user's `~/.pi/agent/auth.json`.

Document that `PI_MODEL` must refer to a built-in Pi model and that the provider key is process-local and not persisted.

## Testing

Extract the small authentication configuration boundary needed to test behavior without starting Slack, Redis, or the HTTP server. Tests must verify:

1. A missing or empty `PI_PROVIDER_API_KEY` is rejected with a clear error.
2. A supplied key creates in-memory authentication and a built-in-only model registry.
3. The key is installed for the provider parsed from `PI_MODEL`.
4. No user-scoped auth or model path is required by the configuration API.

Run the focused tests, the complete test suite, type checking, and lint checks before completion.
