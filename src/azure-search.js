class AzureSearchVectorClient {
  constructor(config, openai) {
    this.config = config;
    this.openai = openai;
  }

  async embed(text, options = {}) {
    const embedding = await this.openai.embeddings.create({
      model: this.config.OPENAI_EMBEDDING_MODEL,
      input: text
    }, {
      signal: options.signal
    });

    return embedding.data[0]?.embedding ?? [];
  }

  async retrieve(userText, options = {}) {
    const topK = Number.isInteger(options.topK) ? Math.min(Math.max(options.topK, 1), 20) : this.config.AZURE_SEARCH_TOP_K;
    const timeoutSignal = AbortSignal.timeout(8000);
    const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
    const vector = await this.embed(userText, { signal });
    if (!vector.length) {
      return [];
    }

    const endpoint = `${this.config.AZURE_SEARCH_ENDPOINT.replace(/\/$/, "")}/indexes/${encodeURIComponent(
      this.config.AZURE_SEARCH_INDEX_NAME
    )}/docs/search?api-version=${encodeURIComponent(this.config.AZURE_SEARCH_API_VERSION)}`;

    const payload = {
      search: userText,
      top: topK,
      select: [
        this.config.AZURE_SEARCH_ID_FIELD,
        this.config.AZURE_SEARCH_TITLE_FIELD,
        this.config.AZURE_SEARCH_CONTENT_FIELD
      ].join(","),
      vectorQueries: [
        {
          kind: "vector",
          vector,
          fields: this.config.AZURE_SEARCH_VECTOR_FIELD,
          k: topK
        }
      ]
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.config.AZURE_SEARCH_API_KEY
      },
      body: JSON.stringify(payload),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Azure Search request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = await response.json();
    const values = Array.isArray(json.value) ? json.value : [];

    return values.map((doc) => ({
      id: String(doc[this.config.AZURE_SEARCH_ID_FIELD] ?? "unknown"),
      title: String(doc[this.config.AZURE_SEARCH_TITLE_FIELD] ?? "Untitled"),
      content: String(doc[this.config.AZURE_SEARCH_CONTENT_FIELD] ?? ""),
      score: Number(doc["@search.score"] ?? 0)
    }));
  }
}

module.exports = { AzureSearchVectorClient };
