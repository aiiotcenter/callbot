class SessionStore {
  constructor(maxTurns) {
    this.maxTurns = maxTurns;
    this.sessions = new Map();

    // Remove stale sessions to avoid unbounded memory growth.
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { history: [] };
    }

    session.lastSeenAt = Date.now();
    return session;
  }

  addTurn(sessionId, role, content) {
    const session = this.sessions.get(sessionId) ?? { history: [], lastSeenAt: Date.now() };

    session.history.push({ role, content });
    const maxMessages = this.maxTurns * 2;
    if (session.history.length > maxMessages) {
      session.history = session.history.slice(session.history.length - maxMessages);
    }

    session.lastSeenAt = Date.now();
    this.sessions.set(sessionId, session);
  }

  cleanup(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastSeenAt > maxAgeMs) {
        this.sessions.delete(id);
      }
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}

module.exports = { SessionStore };
