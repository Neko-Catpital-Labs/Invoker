export type OwnerCapabilityHandler = (...args: unknown[]) => Promise<unknown>;

/** Extract Class: transport-neutral dispatch for capabilities implemented by the active owner. */
export class OwnerCapabilityRegistry {
  private readonly handlers = new Map<string, OwnerCapabilityHandler>();

  register<TResult = unknown>(
    capability: string,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void {
    this.handlers.set(capability, handler as OwnerCapabilityHandler);
  }

  has(capability: string): boolean {
    return this.handlers.has(capability);
  }

  async invoke<TResult = unknown>(capability: string, args: unknown[] = []): Promise<TResult> {
    const handler = this.handlers.get(capability);
    if (!handler) {
      throw new Error(`No owner capability registered for ${capability}`);
    }
    return handler(...args) as Promise<TResult>;
  }
}
