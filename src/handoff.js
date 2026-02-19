async function notifyHandoff(config, payload, logger) {
  if (!config.HUMAN_HANDOFF_WEBHOOK_URL) {
    return;
  }

  try {
    const response = await fetch(config.HUMAN_HANDOFF_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000)
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn(
        {
          statusCode: response.status,
          body: text.slice(0, 200)
        },
        "Handoff webhook returned non-2xx"
      );
    }
  } catch (error) {
    logger.error({ err: error }, "Handoff webhook request failed");
  }
}

module.exports = { notifyHandoff };
