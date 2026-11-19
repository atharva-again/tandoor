import { createModels } from "@earendil-works/pi-ai/models";
import type { FileCredentialStore } from "./auth/credential-store.js";

export const OAUTH_MODEL_PROVIDERS = new Set(["openai", "openai-codex", "xai"]);

export async function getAvailableOAuthModels(
  models: ReturnType<typeof createModels>,
  credentials: Pick<FileCredentialStore, "list">,
) {
  const credentialsList = await credentials.list();
  const authenticatedProviders = [
    ...new Set(
      credentialsList
        .filter(
          (credential) =>
            credential.type === "oauth" && OAUTH_MODEL_PROVIDERS.has(credential.providerId),
        )
        .map((credential) => credential.providerId),
    ),
  ];
  const providerModels = await Promise.all(
    authenticatedProviders.map((providerId) => models.getAvailable(providerId)),
  );
  return {
    authenticatedProviders,
    models: providerModels.flat().filter((model) => model.type === "chat"),
  };
}
