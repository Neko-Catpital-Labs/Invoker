export type OwnerCapabilityHandler = (...args: unknown[]) => Promise<unknown>;

export class OwnerCapabilityRegistry extends Map<string, OwnerCapabilityHandler> {
  register<TResult = unknown>(
    capability: string,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void {
    this.set(capability, handler as OwnerCapabilityHandler);
  }

  async invoke<TResult = unknown>(capability: string, args: unknown[] = []): Promise<TResult> {
    const handler = this.get(capability);
    if (!handler) {
      throw new Error(`No owner capability registered for ${capability}`);
    }
    return handler(...args) as Promise<TResult>;
  }
}
