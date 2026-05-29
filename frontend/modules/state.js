export function createEventBus() {
  const listeners = new Map();
  return {
    on(event, fn) {
      const set = listeners.get(event) || new Set();
      set.add(fn);
      listeners.set(event, set);
      return () => set.delete(fn);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) fn(payload);
    }
  };
}
