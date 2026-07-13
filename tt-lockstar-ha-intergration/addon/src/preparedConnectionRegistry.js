'use strict';

class PreparedConnectionRegistry {
  constructor({
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onError = error => console.error('[Manager] Prepared connection expiry failed:', error),
  } = {}) {
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.onError = onError;
    this.entries = new Map();
  }

  schedule(address, holdMs, onExpire) {
    this.clear(address);
    const expiresAt = this.now() + holdMs;
    let timer;
    timer = this.setTimeoutFn(() => {
      const current = this.entries.get(address);
      if (!current || current.timer !== timer) return;
      this.entries.delete(address);
      Promise.resolve(onExpire()).catch(this.onError);
    }, holdMs);
    if (typeof timer?.unref === 'function') timer.unref();
    this.entries.set(address, { timer, expiresAt });
    return { expiresAt };
  }

  get(address) {
    const entry = this.entries.get(address);
    return entry ? { expiresAt: entry.expiresAt } : undefined;
  }

  claim(address) {
    const entry = this.entries.get(address);
    if (!entry) return undefined;
    this.clearTimeoutFn(entry.timer);
    this.entries.delete(address);
    return { expiresAt: entry.expiresAt };
  }

  clear(address) {
    return this.claim(address);
  }
}

module.exports = PreparedConnectionRegistry;
