/** The only state shared between sign-in features: one active sign-in per user. */
export class TelegramLoginCoordinator {
  private readonly users = new Set<number>();

  claim(userId: number): (() => void) | undefined {
    if (this.users.has(userId)) return undefined;
    this.users.add(userId);
    return () => { this.users.delete(userId); };
  }
}
