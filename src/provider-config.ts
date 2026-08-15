import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export function createProjectProviderServices(
  provider: string,
  apiKey: string | undefined,
): Promise<{
  credentialStore: InMemoryCredentialStore;
  modelRuntime: ModelRuntime;
}> {
  if (!apiKey?.trim()) {
    throw new Error("PI_CHAT_PROVIDER_API_KEY env variable is required");
  }

  return createInMemoryProviderServices(provider, apiKey);
}

async function createInMemoryProviderServices(
  provider: string,
  apiKey: string,
): Promise<{
  credentialStore: InMemoryCredentialStore;
  modelRuntime: ModelRuntime;
}> {
  const credentialStore = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey(provider, apiKey, {
    allowNetwork: false,
  });

  return {
    credentialStore,
    modelRuntime,
  };
}
