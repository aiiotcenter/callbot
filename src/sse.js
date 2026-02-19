function setupSse(reply) {
  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders();
}

function writeSseEvent(reply, eventName, data) {
  if (reply.raw.writableEnded || reply.raw.destroyed) {
    return;
  }

  reply.raw.write(`event: ${eventName}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

  if (typeof reply.raw.flush === "function") {
    reply.raw.flush();
  }
}

function endSse(reply) {
  if (!reply.raw.writableEnded && !reply.raw.destroyed) {
    reply.raw.end();
  }
}

module.exports = {
  setupSse,
  writeSseEvent,
  endSse
};
