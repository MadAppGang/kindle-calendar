/**
 * Secret Manager client with in-memory cache.
 * Fetches secrets from Google Cloud Secret Manager.
 *
 * @stub - Not yet implemented.
 */
export class SecretManagerClient {
  private readonly cache = new Map<string, string>();

  /**
   * Fetches the latest version of a secret by name.
   * Results are cached in memory for the lifetime of this instance.
   */
  async getSecret(_secretName: string): Promise<string> {
    throw new Error(
      "SecretManagerClient not yet implemented. " +
      "Will use @google-cloud/secret-manager to fetch secrets and cache results in memory."
    );
  }

  /**
   * Clears the in-memory secret cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// Singleton instance for use across the application
export const secretManager = new SecretManagerClient();
