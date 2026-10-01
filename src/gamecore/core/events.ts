/** 轻量事件总线：战斗事件（onKill/onHit/onWallHit/onWaveClear…）供报表、渲染层、音频订阅。 */
export type Handler<T = unknown> = (payload: T) => void;

export class EventBus {
  private map = new Map<string, Set<Handler<never>>>();

  on<T>(event: string, handler: Handler<T>): void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(handler as Handler<never>);
  }

  emit<T>(event: string, payload: T): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const h of set) (h as Handler<T>)(payload);
  }

  clear(): void {
    this.map.clear();
  }
}
