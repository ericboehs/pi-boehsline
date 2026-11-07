# providers

Changes to pi's built-in providers, made with `pi.registerProvider()`: a complete pi-ai `Provider`
with a built-in's id replaces it, and `models.json` still applies above it. Both used to be patches
in a pi fork.

- **`disabledProviders`**: provider ids in `~/.pi/agent/settings.json`, for example
  `["amazon-bedrock", "baseten", "fireworks"]`. Each is re-registered with `filterModels` and
  `filterAllModels` returning nothing, so its models leave every availability read (`/model`,
  Ctrl+P cycling, startup selection, subagent model lists) but stay in the catalog: an explicit
  `--model amazon-bedrock/...` still resolves. For providers pi offers because of ambient
  credentials, such as AWS environment variables.
- **zstd for GitHub Copilot**: Anthropic Messages request bodies go zstd-compressed (level 3,
  `Content-Encoding: zstd`), about 100 ms faster per turn on a ~535 KB body. A 400 or 415 to a
  compressed body is retried once uncompressed; when that retry is accepted, the base URL stays
  uncompressed until pi exits. A runtime without zstd sends bodies as they are. Disabling
  `github-copilot` turns this off with it.

The factory is async: pi awaits it, so the overrides are in place before startup picks a model.
