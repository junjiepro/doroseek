import { getParentKey, loadList } from "../services/database.ts";

interface Endpoint {
  id: string;
  endpoint: string;
  apiKey: string;
  model: string;
}
interface EndpointModel {
  id: string;
  model: string;
}
interface EndpointConfig {
  endpointIds: string[];
  models: Record<string, EndpointModel[]>;
  endpoints: Record<string, Endpoint>;
}

class LoadBalancer {
  private endpoints: Record<string, EndpointConfig>;
  private readonly maxRetries: number;

  constructor(maxRetries = 3) {
    this.endpoints = {};
    this.maxRetries = maxRetries;
  }

  removeEndpoint(listId: string): void {
    delete this.endpoints[listId];
  }

  async loadEndpointConfig(listId: string): Promise<EndpointConfig | null> {
    const config = this.endpoints[listId];
    if (config) {
      return config;
    }

    const list = await loadList(listId, "strong", true);
    if (list.items.length === 0) {
      const parentId = await getParentKey(listId);
      if (!parentId) return null;
      return await this.loadEndpointConfig(parentId);
    }

    const items = list.items.filter((item) => item.enabled);

    this.endpoints[listId] = {
      endpointIds: items.map((item) => item.id ?? ""),
      models: items.reduce((acc, item) => {
        item.models.forEach((model) => {
          const [a, b] = model.split("@");
          const realModel = b ?? a;
          acc[a] = acc[a] || [];
          acc[a].push({ id: item.id ?? "", model: realModel });
          if (b) {
            acc[b] = acc[b] || [];
            acc[b].push({ id: item.id ?? "", model: realModel });
          }
        });
        return acc;
      }, {} as Record<string, EndpointModel[]>),
      endpoints: items.reduce(
        (acc, item) => ({
          ...acc,
          [item.id ?? ""]: {
            id: item.id ?? "",
            endpoint: item.endpoint,
            apiKey: item.apiKey,
            model: "",
          },
        }),
        {} as Record<string, Endpoint>
      ),
    };

    return this.endpoints[listId];
  }

  async getNextEndpoint(
    listId: string,
    modelName: string
  ): Promise<Endpoint | null> {
    const config = await this.loadEndpointConfig(listId);

    if (!config) return null;

    let models = config.models[modelName];
    if (!models || models.length === 0) {
      models = config.endpointIds.map((id) => ({ id, model: modelName }));
    }

    if (!models || models.length === 0) return null;

    // 随机选择一个 endpoint
    const { id, model } = models[Math.floor(Math.random() * models.length)];
    const endpoint = config.endpoints[id];
    if (!endpoint) return null;

    return { ...endpoint, model };
  }

  // 处理请求并转发
  async handleRequest(
    url: string,
    request: Request,
    retryCount = 0
  ): Promise<Response> {
    if (retryCount >= this.maxRetries) {
      return new Response("Service unavailable, please try again later", {
        status: 503,
      });
    }

    try {
      const apiKey1 = request.headers.get("apiKey");
      const [_, apiKey2] = (request.headers.get("Authorization") ?? "").split(
        "Bearer "
      );
      const apiKey = apiKey1 ?? apiKey2;
      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: "Authorization header is missing" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
      // 解析请求体
      const requestBody = await request.clone().json();
      const customModelName = requestBody.model;

      // 查找实际模型名
      const endpoint = await this.getNextEndpoint(apiKey, customModelName);
      if (!endpoint) {
        return new Response(
          JSON.stringify({
            error: `Model '${customModelName}' not supported for your API key`,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // 替换模型名
      const proxiedRequestBody = {
        ...requestBody,
        model: endpoint.model,
      };

      // 转发请求
      const proxyResponse = await fetch(
        `${endpoint.endpoint}${
          endpoint.endpoint.endsWith("/") ? "" : "/"
        }${url}`,
        {
          method: request.method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${endpoint.apiKey}`,
            apiKey: endpoint.apiKey,
          },
          body: JSON.stringify(proxiedRequestBody),
        }
      );

      if (!proxyResponse.ok && proxyResponse.status >= 500) {
        console.error(
          `Proxy request failed: ${proxyResponse.status}, ${proxyResponse.statusText}`
        );
        return this.handleRequest(url, request, retryCount + 1);
      }

      return handleStreamResponse(proxyResponse);
    } catch (error) {
      console.error(`Request failed: ${error}`);
      return this.handleRequest(url, request, retryCount + 1);
    }
  }
}

// 处理流式响应
const handleStreamResponse = (response: Response) => {
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const reader = response.body?.getReader();
    if (!reader) {
      return new Response("Internal Server Error", { status: 500 });
    }

    const stream = new ReadableStream({
      async start(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      },
      cancel() {
        reader.cancel();
      },
    });

    return new Response(stream, {
      status: response.status,
      headers: {
        "content-type": "text/event-stream",
      },
    });
  } else {
    return response;
  }
};

const loadBalancer = new LoadBalancer();

export default loadBalancer;
