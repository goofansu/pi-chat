import { fileURLToPath } from "node:url";

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  type AgentSessionServices,
  type CreateAgentSessionServicesOptions,
  createAgentSessionServices,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

type ProjectProviderOptions = Pick<
  CreateAgentSessionServicesOptions,
  "cwd" | "agentDir" | "resourceLoaderOptions"
>;

type ProjectProviderServices = AgentSessionServices & {
  credentialStore: InMemoryCredentialStore;
};

export function createProjectProviderServices(
  provider: string,
  apiKey: string | undefined,
  options: ProjectProviderOptions = { cwd: process.cwd() },
): Promise<ProjectProviderServices> {
  if (provider !== "claude-code" && !apiKey?.trim()) {
    throw new Error("PI_CHAT_PROVIDER_API_KEY env variable is required");
  }

  return createInMemoryProviderServices(provider, apiKey, options);
}

async function createInMemoryProviderServices(
  provider: string,
  apiKey: string | undefined,
  options: ProjectProviderOptions,
): Promise<ProjectProviderServices> {
  const credentialStore = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  // Claude Code owns its login. Never replace its ambient auth with a project key.
  if (provider !== "claude-code" && apiKey) {
    await modelRuntime.setRuntimeApiKey(provider, apiKey);
  }

  // Use Pi's extension loader for TypeScript packages and shared Pi module aliases.
  // Services apply provider registrations before the caller selects a model.
  const services = await createAgentSessionServices({
    ...options,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      ...options.resourceLoaderOptions,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [
        ...(provider === "claude-code"
          ? [
              fileURLToPath(
                import.meta.resolve(
                  "@earendil-works/pi-claude-code/src/index.ts",
                ),
              ),
            ]
          : []),
        ...(options.resourceLoaderOptions?.additionalExtensionPaths ?? []),
      ],
    },
  });
  const errors = [
    ...services.resourceLoader
      .getExtensions()
      .errors.map(({ path, error }) => `${path}: ${error}`),
    ...services.diagnostics
      .filter(({ type }) => type === "error")
      .map(({ message }) => message),
  ];
  if (errors.length > 0) {
    throw new Error(`Failed to load Pi extensions: ${errors.join("; ")}`);
  }

  return { ...services, credentialStore };
}
