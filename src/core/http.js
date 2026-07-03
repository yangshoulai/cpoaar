export class HttpError extends Error {
  constructor(message, { status = 0, body = "", url = "" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export class HttpClient {
  constructor(config = {}) {
    this.defaultTimeout = Number(config.defaultTimeout || 30) * 1000;
    this.defaultHeaders = {
      ...(config.defaultHeaders || {})
    };
  }

  async get(url, options = {}) {
    return this.request(url, { ...options, method: "GET" });
  }

  async post(url, body, options = {}) {
    return this.request(url, {
      ...options,
      method: "POST",
      body
    });
  }

  async put(url, body, options = {}) {
    return this.request(url, {
      ...options,
      method: "PUT",
      body
    });
  }

  async request(url, options = {}) {
    const targetUrl = appendQuery(url, options.query);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || this.defaultTimeout);
    const abortByExternalSignal = () => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener?.("abort", abortByExternalSignal, { once: true });
    }
    const headers = sanitizeHeaders({
      ...this.defaultHeaders,
      ...(options.headers || {})
    });
    let body = options.body;
    if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof FormData)) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      body = JSON.stringify(body);
    }

    try {
      const response = await fetch(targetUrl, {
        method: options.method || "GET",
        headers,
        body,
        credentials: options.credentials ?? "omit",
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new HttpError(`HTTP 请求失败: ${response.status}`, {
          status: response.status,
          body: text,
          url: targetUrl
        });
      }
      if (options.responseType === "text") {
        return text;
      }
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new HttpError(`响应不是合法 JSON: ${error.message}`, {
          status: response.status,
          body: text,
          url: targetUrl
        });
      }
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(`HTTP 请求无法发送: ${error.message}`, {
        status: 0,
        body: error.stack || String(error),
        url: targetUrl
      });
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener?.("abort", abortByExternalSignal);
    }
  }
}

function sanitizeHeaders(headers) {
  const forbidden = new Set(["user-agent", "host", "origin", "referer"]);
  return Object.fromEntries(
    Object.entries(headers || {}).filter(([key]) => !forbidden.has(key.toLowerCase()))
  );
}

export function joinUrl(baseUrl, path) {
  const trimmedBase = String(baseUrl || "").replace(/\/+$/, "");
  const trimmedPath = String(path || "").replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedPath}`;
}

export function appendQuery(url, query = null) {
  if (!query) {
    return url;
  }
  const target = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}
