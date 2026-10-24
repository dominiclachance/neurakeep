export interface ManagedIdentityClientState {
  configured: boolean;
  user: { email?: string | null; displayName?: string | null } | null;
  token: string;
}

export function managedIdentityConfigured(): boolean {
  return false;
}

export async function signInWithManagedIdentity(): Promise<ManagedIdentityClientState> {
  throw new Error("Managed sign-in is not included in the open-source build.");
}

export async function signInWithEnterpriseProvider(_providerId?: string, _type?: "saml" | "oidc"): Promise<ManagedIdentityClientState> {
  throw new Error("Enterprise sign-in is not included in the open-source build.");
}

export async function signOutOfManagedIdentity(): Promise<void> {
  // The OSS build never creates a managed browser session.
}
