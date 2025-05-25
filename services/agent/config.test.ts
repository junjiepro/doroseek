import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "https://deno.land/std@0.212.0/assert/mod.ts";
import { loadAgentConfig, AgentConfig, AgentServiceConfig } from "./config.ts";

// Helper to set environment variables for a test and restore them after
function withEnv(envVars: Record<string, string | undefined>, testFn: () => void) {
  const originalEnv: Record<string, string | undefined> = {};
  for (const key in envVars) {
    originalEnv[key] = Deno.env.get(key);
    if (envVars[key] === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, envVars[key]!);
    }
  }

  try {
    testFn();
  } finally {
    for (const key in originalEnv) {
      if (originalEnv[key] === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, originalEnv[key]!);
      }
    }
  }
}

Deno.testSuite("Agent Configuration (services/agent/config.ts)", async (t) => {
  const validServiceJson = JSON.stringify([
    {
      id: "web1",
      name: "My Web Service",
      type: "http",
      local_host: "localhost",
      local_port: 3000,
      subdomainOrPath: "web",
    },
    {
      id: "api1",
      name: "My API Service",
      type: "http",
      local_host: "127.0.0.1",
      local_port: 8080,
      subdomainOrPath: "api",
    },
  ]);

  const minimalValidEnv = {
    DOROSEEK_AGENT_MODE_ENABLED: "true",
    DOROSEEK_RELAY_URL: "wss://example.com/mcp/tunnel/register",
    DOROSEEK_AGENT_API_KEY: "test-api-key",
    DOROSEEK_AGENT_SERVICES_JSON: validServiceJson,
  };

  await t.step("loadAgentConfig - Successful loading", () => {
    withEnv(minimalValidEnv, () => {
      const config = loadAgentConfig();
      assert(config !== null, "Config should not be null for valid environment");
      assertEquals(config?.relayUrl, minimalValidEnv.DOROSEEK_RELAY_URL);
      assertEquals(config?.apiKey, minimalValidEnv.DOROSEEK_AGENT_API_KEY);
      assertEquals(config?.services.length, 2);
      assertEquals(config?.services[0].id, "web1");
      assertEquals(config?.services[1].local_port, 8080);
    });
  });

  await t.step("loadAgentConfig - Agent mode disabled (DOROSEEK_AGENT_MODE_ENABLED=false)", () => {
    withEnv({ ...minimalValidEnv, DOROSEEK_AGENT_MODE_ENABLED: "false" }, () => {
      const config = loadAgentConfig();
      assertEquals(config, null, "Config should be null when agent mode is false");
    });
  });

  await t.step("loadAgentConfig - Agent mode disabled (DOROSEEK_AGENT_MODE_ENABLED not set)", () => {
    const envWithoutEnabled = { ...minimalValidEnv };
    delete envWithoutEnabled.DOROSEEK_AGENT_MODE_ENABLED;
    withEnv(envWithoutEnabled, () => {
      const config = loadAgentConfig();
      assertEquals(config, null, "Config should be null when agent mode env var is not set");
    });
  });

  await t.step("loadAgentConfig - Missing DOROSEEK_RELAY_URL", () => {
    const env = { ...minimalValidEnv };
    delete env.DOROSEEK_RELAY_URL;
    withEnv(env, () => {
      // Suppress console.error during this test if desired, or check for its output
      const consoleErrorSpy = { error: (...args: any[]) => {} }; // Simple spy
      const originalConsoleError = console.error;
      console.error = consoleErrorSpy.error;
      const config = loadAgentConfig();
      console.error = originalConsoleError; // Restore
      assertEquals(config, null);
    });
  });

  await t.step("loadAgentConfig - Missing DOROSEEK_AGENT_API_KEY", () => {
    const env = { ...minimalValidEnv };
    delete env.DOROSEEK_AGENT_API_KEY;
    withEnv(env, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });

  await t.step("loadAgentConfig - Missing DOROSEEK_AGENT_SERVICES_JSON", () => {
    const env = { ...minimalValidEnv };
    delete env.DOROSEEK_AGENT_SERVICES_JSON;
    withEnv(env, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });

  await t.step("loadAgentConfig - Invalid DOROSEEK_RELAY_URL format (http instead of ws/wss)", () => {
    withEnv({ ...minimalValidEnv, DOROSEEK_RELAY_URL: "http://example.com" }, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });

  await t.step("loadAgentConfig - Malformed DOROSEEK_AGENT_SERVICES_JSON", () => {
    withEnv({ ...minimalValidEnv, DOROSEEK_AGENT_SERVICES_JSON: "this is not json" }, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });

  await t.step("loadAgentConfig - DOROSEEK_AGENT_SERVICES_JSON is not an array", () => {
    withEnv({ ...minimalValidEnv, DOROSEEK_AGENT_SERVICES_JSON: JSON.stringify({ not: "an array" }) }, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });
  
  await t.step("loadAgentConfig - DOROSEEK_AGENT_SERVICES_JSON is an empty array", () => {
    withEnv({ ...minimalValidEnv, DOROSEEK_AGENT_SERVICES_JSON: JSON.stringify([]) }, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });


  await t.step("loadAgentConfig - Invalid service object (missing id)", () => {
    const invalidService = [{ name: "Test", type: "http", local_host: "localhost", local_port: 80, subdomainOrPath: "test" }];
    withEnv({ ...minimalValidEnv, DOROSEEK_AGENT_SERVICES_JSON: JSON.stringify(invalidService) }, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });

  await t.step("loadAgentConfig - Invalid service object (invalid type)", () => {
    const invalidService = [{ id: "s1", name: "Test", type: "ftp", local_host: "localhost", local_port: 80, subdomainOrPath: "test" }];
    withEnv({ ...minimalValidEnv, DOROSEEK_AGENT_SERVICES_JSON: JSON.stringify(invalidService) }, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });

  await t.step("loadAgentConfig - Invalid service object (invalid local_port)", () => {
    const invalidService = [{ id: "s1", name: "Test", type: "http", local_host: "localhost", local_port: "not-a-number", subdomainOrPath: "test" }];
    withEnv({ ...minimalValidEnv, DOROSEEK_AGENT_SERVICES_JSON: JSON.stringify(invalidService) }, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });
  
  await t.step("loadAgentConfig - Invalid service object (subdomainOrPath contains '/')", () => {
    const invalidService = [{ id: "s1", name: "Test", type: "http", local_host: "localhost", local_port: 8080, subdomainOrPath: "test/path" }];
    withEnv({ ...minimalValidEnv, DOROSEEK_AGENT_SERVICES_JSON: JSON.stringify(invalidService) }, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });

  await t.step("loadAgentConfig - Invalid service object (subdomainOrPath contains space)", () => {
    const invalidService = [{ id: "s1", name: "Test", type: "http", local_host: "localhost", local_port: 8080, subdomainOrPath: "test path" }];
    withEnv({ ...minimalValidEnv, DOROSEEK_AGENT_SERVICES_JSON: JSON.stringify(invalidService) }, () => {
      const config = loadAgentConfig();
      assertEquals(config, null);
    });
  });

});
