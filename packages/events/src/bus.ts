import type { JarvisEvent, JarvisEventMap, JarvisEventName } from './events.js';

type Listener<K extends JarvisEventName> = (payload: JarvisEventMap[K]) => void;
type AnyListener = (event: JarvisEvent) => void;

/** Minimal typed pub/sub. No external dependency so it runs in Node and the webview. */
export class EventBus {
  private readonly listeners = new Map<JarvisEventName, Set<Listener<JarvisEventName>>>();
  private readonly anyListeners = new Set<AnyListener>();

  on<K extends JarvisEventName>(name: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener as Listener<JarvisEventName>);
    return () => {
      set?.delete(listener as Listener<JarvisEventName>);
    };
  }

  onAny(listener: AnyListener): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  emit<K extends JarvisEventName>(name: K, payload: JarvisEventMap[K]): void {
    const event = { name, payload, time: new Date().toISOString() } as JarvisEvent;
    for (const listener of this.listeners.get(name) ?? []) {
      (listener as Listener<K>)(payload);
    }
    for (const listener of this.anyListeners) {
      listener(event);
    }
  }

  clear(): void {
    this.listeners.clear();
    this.anyListeners.clear();
  }
}
