import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertSpyCall,
  assertSpyCalls,
  spy,
} from "https://deno.land/std@0.212.0/testing/mock.ts";
import { delay } from "https://deno.land/std@0.212.0/async/delay.ts";
import { v4 as uuidv4 } from "uuid";

import {
  initializeBroadcastListeners,
  closeBroadcastChannels,
  postHttpRequestToChannel,
  postHttpResponseToChannel,
  postTunnelActivityToChannel,
  postHealthCheckToChannel,
  postHealthCheckResponseToChannel,
  // Import message types for constructing test messages
  BroadcastHttpRequestMessage,
  BroadcastHttpResponseMessage,
  TunnelActivityMessage,
} from "./inter_instance_comms.ts";
import {
  BroadcastHealthCheckMessage,
  BroadcastHealthCheckResponseMessage,
  HealthStatusReport,
} from "../../shared/health.ts";


import * as tunnelRegistry from "./distributed_tunnel_registry.ts";
import * as tunnelService from "../services/mcp/server/tunnel.ts";
import *s forwardedReqRegistry from "./forwarded_request_registry.ts";
import { RELAY_INSTANCE_ID as CURRENT_INSTANCE_ID_RAW } from "../../lib/utils.ts";

// --- Mock BroadcastChannel ---
type MessageEventListenerTuple = [EventListenerOrEventListenerObject, AddEventListenerOptions | boolean | undefined];

class MockBroadcastChannel {
  public name: string;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  private static channelsByName = new Map<string, Set<MockBroadcastChannel>>();

  constructor(name: string) {
    this.name = name;
    if (!MockBroadcastChannel.channelsByName.has(name)) {
      MockBroadcastChannel.channelsByName.set(name, new Set());
    }
    MockBroadcastChannel.channelsByName.get(name)!.add(this);
  }

  postMessage(message: any): void {
    const targetChannels = MockBroadcastChannel.channelsByName.get(this.name);
    if (targetChannels) {
      targetChannels.forEach(channel => {
        if (channel !== this && channel.onmessage) { // Don't send to self, and only if listener attached
          // Simulate async delivery
          setTimeout(() => {
            channel.onmessage!(new MessageEvent("message", { data: message }));
          }, 0);
        }
      });
    }
  }

  close(): void {
    const channels = MockBroadcastChannel.channelsByName.get(this.name);
    if (channels) {
      channels.delete(this);
      if (channels.size === 0) {
        MockBroadcastChannel.channelsByName.delete(this.name);
      }
    }
    this.onmessage = null; // Clear listener on close
  }
  
  // Deno's BroadcastChannel also has addEventListener/removeEventListener
  addEventListener(type: "message", listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): void {
    if (type === "message") {
        this.onmessage = listener as (event: MessageEvent) => void; // Simplified: directly assign
    }
  }
  removeEventListener(_type: string, _listener: any, _options?: any): void {
    // For simplicity, this mock might not fully implement removeEventListener
    // if onmessage is directly assigned. If using a list of listeners, implement removal.
    this.onmessage = null;
  }


  static clearAllChannels(): void {
    MockBroadcastChannel.channelsByName.clear();
  }
}

// --- Test Suite ---
Deno.testSuite("Inter-Instance Communication (services/inter_instance_comms.ts)", async (t) => {
  let originalBroadcastChannel: typeof BroadcastChannel;
  let currentInstanceId: string;

  // Spies for dependencies
  let setTunnelOwnerSpy: any;
  let removeTunnelOwnerSpy: any;
  let getTunnelOwnerInstanceSpy: any;
  let forwardRequestToLocalAgentSpy: any;
  let initiateForwardedAgentHealthCheckSpy: any;
  let resolveForwardedRequestSpy: any;

  t.beforeEach(() => {
    originalBroadcastChannel = globalThis.BroadcastChannel;
    (globalThis as any).BroadcastChannel = MockBroadcastChannel;
    MockBroadcastChannel.clearAllChannels();
    
    // RELAY_INSTANCE_ID is const, so we need to mock the module or use a dynamic way to set it for tests.
    // For simplicity, we'll assume tests run as if they are CURRENT_INSTANCE_ID_RAW.
    // If we needed to simulate messages *to* this instance from a *different* mocked instance,
    // we'd need a more complex setup or to modify RELAY_INSTANCE_ID.
    // For these tests, we mainly check if *this* instance ignores its own messages or processes others.
    currentInstanceId = CURRENT_INSTANCE_ID_RAW; // Use the actual instance ID for "self" checks

    // Setup spies
    setTunnelOwnerSpy = spy(tunnelRegistry, "setTunnelOwner");
    removeTunnelOwnerSpy = spy(tunnelRegistry, "removeTunnelOwner");
    getTunnelOwnerInstanceSpy = spy(tunnelRegistry, "getTunnelOwnerInstance");
    forwardRequestToLocalAgentSpy = spy(tunnelService, "forwardRequestToLocalAgent");
    initiateForwardedAgentHealthCheckSpy = spy(tunnelService, "initiateForwardedAgentHealthCheck");
    resolveForwardedRequestSpy = spy(forwardedReqRegistry, "resolveForwardedRequest");
    
    // Initialize listeners for each test, as they create channels
    initializeBroadcastListeners(); 
  });

  t.afterEach(() => {
    globalThis.BroadcastChannel = originalBroadcastChannel;
    MockBroadcastChannel.clearAllChannels();
    // Restore spies
    setTunnelOwnerSpy.restore();
    removeTunnelOwnerSpy.restore();
    getTunnelOwnerInstanceSpy.restore();
    forwardRequestToLocalAgentSpy.restore();
    initiateForwardedAgentHealthCheckSpy.restore();
    resolveForwardedRequestSpy.restore();
    closeBroadcastChannels(); // Ensure channels are closed
  });

  await t.step("initializeBroadcastListeners - creates channels and attaches listeners", () => {
    // initializeBroadcastListeners() is called in beforeEach.
    // Check if channels were created (mock BroadcastChannel constructor tracks this implicitly)
    assert(MockBroadcastChannel.channelsByName.has("doroseek-tunnel-requests"), "Request channel should be created");
    assert(MockBroadcastChannel.channelsByName.has("doroseek-tunnel-responses"), "Response channel should be created");
    assert(MockBroadcastChannel.channelsByName.has("doroseek-tunnel-activity"), "Activity channel should be created");
    assert(MockBroadcastChannel.channelsByName.has("doroseek-health-check-requests"), "Health check request channel should be created");
    assert(MockBroadcastChannel.channelsByName.has("doroseek-health-check-responses"), "Health check response channel should be created");
  });

  await t.step("handleBroadcastRequest - forwards to local agent if targeted or general", async () => {
    const otherInstanceId = "instance-B";
    const tunnelId = "tunnel-1";
    const jobId = "job-req-1"; // This is the requestId from the original instance

    const httpRequest: BroadcastHttpRequestMessage = {
      type: "httpRequest",
      originalInstanceId: otherInstanceId,
      targetInstanceId: currentInstanceId, // Explicitly target current instance
      tunnelId,
      requestId: jobId,
      requestData: { method: "GET", path: "/foo", headers: {}, body: null },
    };
    
    forwardRequestToLocalAgentSpy.mockResolvedValue(true); // Assume agent is connected

    // Simulate receiving this message from another instance
    const receivingChannel = new MockBroadcastChannel("doroseek-tunnel-requests"); // Simulates this instance's listener
    // Manually trigger onmessage for the initialized listener
    const actualListener = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-tunnel-requests")!)[0];
    actualListener.onmessage!(new MessageEvent("message", { data: httpRequest }));
    
    await delay(10); // Allow async operations in handler

    assertSpyCalls(forwardRequestToLocalAgentSpy, 1);
    assertSpyCall(forwardRequestToLocalAgentSpy, 0, {
      args: [
        tunnelId,
        sinon.match.string, // The new requestIdForAgent (a UUID)
        jobId, // originalJobId
        otherInstanceId, // originalInstanceId
        httpRequest.requestData,
      ],
    });
    receivingChannel.close();
  });
  
  await t.step("handleBroadcastRequest - ignores if targeted to another specific instance", async () => {
    const httpRequest: BroadcastHttpRequestMessage = {
      type: "httpRequest",
      originalInstanceId: "instance-B",
      targetInstanceId: "instance-C", // Not this instance
      tunnelId: "tunnel-2",
      requestId: "job-req-2",
      requestData: { method: "GET", path: "/bar", headers: {}, body: null },
    };
    
    const receivingChannel = new MockBroadcastChannel("doroseek-tunnel-requests");
    const actualListener = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-tunnel-requests")!)[0];
    actualListener.onmessage!(new MessageEvent("message", { data: httpRequest }));
    await delay(10);

    assertSpyCalls(forwardRequestToLocalAgentSpy, 0); // Should not be called
    receivingChannel.close();
  });


  await t.step("handleBroadcastResponse - resolves pending forwarded request if targeted", async () => {
    const otherInstanceId = "instance-B"; // Instance that handled the agent
    const jobId = "job-resp-1"; // This is the ID this instance is waiting for

    const httpResponse: BroadcastHttpResponseMessage = {
      type: "httpResponse",
      originalInstanceId: otherInstanceId, // Instance that sends this broadcast
      targetInstanceId: currentInstanceId, // This instance is the target
      tunnelId: "tunnel-3",
      requestId: jobId, // Corresponds to forwardedReqRegistry key
      responseData: { status: 200, headers: {}, body: "OK" },
    };

    const receivingChannel = new MockBroadcastChannel("doroseek-tunnel-responses");
    const actualListener = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-tunnel-responses")!)[0];
    actualListener.onmessage!(new MessageEvent("message", { data: httpResponse }));
    await delay(10);
    
    assertSpyCalls(resolveForwardedRequestSpy, 1);
    assertSpyCall(resolveForwardedRequestSpy, 0, {
      args: [jobId, httpResponse.responseData],
    });
    receivingChannel.close();
  });

  await t.step("handleTunnelActivity - sets owner on 'connected'", async () => {
    const activity: TunnelActivityMessage = {
      type: "tunnelActivity",
      originalInstanceId: "instance-D",
      tunnelId: "tunnel-act-1",
      activity: "connected",
    };
    const receivingChannel = new MockBroadcastChannel("doroseek-tunnel-activity");
    const actualListener = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-tunnel-activity")!)[0];
    actualListener.onmessage!(new MessageEvent("message", { data: activity }));
    await delay(10);

    assertSpyCalls(setTunnelOwnerSpy, 1);
    assertSpyCall(setTunnelOwnerSpy, 0, {
      args: [activity.tunnelId, activity.originalInstanceId],
    });
    receivingChannel.close();
  });

  await t.step("handleTunnelActivity - removes owner on 'disconnected' if owner matches", async () => {
    const ownerInstance = "instance-E";
    const tunnelId = "tunnel-act-2";
    // Simulate this instance knows 'ownerInstance' owns 'tunnelId'
    getTunnelOwnerInstanceSpy.mockResolvedValue(ownerInstance); 

    const activity: TunnelActivityMessage = {
      type: "tunnelActivity",
      originalInstanceId: ownerInstance, // The owner reports disconnect
      tunnelId,
      activity: "disconnected",
    };
    const receivingChannel = new MockBroadcastChannel("doroseek-tunnel-activity");
    const actualListener = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-tunnel-activity")!)[0];
    actualListener.onmessage!(new MessageEvent("message", { data: activity }));
    await delay(10);

    assertSpyCalls(removeTunnelOwnerSpy, 1);
    assertSpyCall(removeTunnelOwnerSpy, 0, { args: [tunnelId] });
    receivingChannel.close();
  });
  
   await t.step("handleTunnelActivity - ignores 'disconnected' if owner does not match", async () => {
    const ownerInstance = "instance-REAL-OWNER";
    const otherInstance = "instance-STALE-REPORTER";
    const tunnelId = "tunnel-act-3";
    getTunnelOwnerInstanceSpy.mockResolvedValue(ownerInstance);

    const activity: TunnelActivityMessage = {
      type: "tunnelActivity",
      originalInstanceId: otherInstance, // A different instance reports disconnect
      tunnelId,
      activity: "disconnected",
    };
     const receivingChannel = new MockBroadcastChannel("doroseek-tunnel-activity");
    const actualListener = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-tunnel-activity")!)[0];
    actualListener.onmessage!(new MessageEvent("message", { data: activity }));
    await delay(10);

    assertSpyCalls(removeTunnelOwnerSpy, 0); // Should not call remove
    receivingChannel.close();
  });


  // Tests for handleBroadcastHealthCheckRequest and handleBroadcastHealthCheckResponse
  await t.step("handleBroadcastHealthCheckRequest - calls initiateForwardedAgentHealthCheck if targeted", async () => {
    const healthCheckReq: BroadcastHealthCheckMessage = {
      type: "forwardHealthCheck",
      originalInstanceId: "instance-F",
      targetInstanceId: currentInstanceId,
      tunnelId: "tunnel-hc-1",
      healthCheckJobId: "hcjob-1",
    };
    
    const receivingChannel = new MockBroadcastChannel("doroseek-health-check-requests");
    const actualListener = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-health-check-requests")!)[0];
    actualListener.onmessage!(new MessageEvent("message", { data: healthCheckReq }));
    await delay(10);

    assertSpyCalls(initiateForwardedAgentHealthCheckSpy, 1);
    assertSpyCall(initiateForwardedAgentHealthCheckSpy, 0, {
      args: [healthCheckReq.tunnelId, healthCheckReq.healthCheckJobId, healthCheckReq.originalInstanceId],
    });
    receivingChannel.close();
  });

  await t.step("handleBroadcastHealthCheckResponse - resolves forwarded request if targeted", async () => {
    const healthCheckResp: BroadcastHealthCheckResponseMessage = {
      type: "forwardHealthCheckResponse",
      originalInstanceId: "instance-G", // Instance that performed the check
      targetInstanceId: currentInstanceId, // This instance is waiting
      tunnelId: "tunnel-hc-2",
      healthCheckJobId: "hcjob-2",
      statusReport: { tunnelId: "tunnel-hc-2", tunnelStatus: "connected", localServiceStatus: "ok", checkedByInstanceId: "instance-G", timestamp: new Date().toISOString() }
    };

    const receivingChannel = new MockBroadcastChannel("doroseek-health-check-responses");
    const actualListener = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-health-check-responses")!)[0];
    actualListener.onmessage!(new MessageEvent("message", { data: healthCheckResp }));
    await delay(10);

    assertSpyCalls(resolveForwardedRequestSpy, 1);
    assertSpyCall(resolveForwardedRequestSpy, 0, {
      args: [healthCheckResp.healthCheckJobId, healthCheckResp.statusReport],
    });
    receivingChannel.close();
  });

  // Test posting functions - verify they call postMessage on the mock channel
  await t.step("Posting functions - call postMessage on correct channel", async () => {
    // Spy on the actual postMessage of the mock instances
    const mockReqChannelInstance = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-tunnel-requests")!)[0];
    const mockRespChannelInstance = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-tunnel-responses")!)[0];
    const mockActivityChannelInstance = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-tunnel-activity")!)[0];
    const mockHealthReqChannelInstance = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-health-check-requests")!)[0];
    const mockHealthRespChannelInstance = Array.from(MockBroadcastChannel.channelsByName.get("doroseek-health-check-responses")!)[0];

    const postMessageSpies = [
        spy(mockReqChannelInstance, "postMessage"),
        spy(mockRespChannelInstance, "postMessage"),
        spy(mockActivityChannelInstance, "postMessage"),
        spy(mockHealthReqChannelInstance, "postMessage"),
        spy(mockHealthRespChannelInstance, "postMessage"),
    ];
    
    const commonPayload = { originalInstanceId: currentInstanceId }; // Will be added by post functions

    postHttpRequestToChannel({ tunnelId: "t1", requestId: "r1", requestData: {} as any });
    postHttpResponseToChannel({ tunnelId: "t2", requestId: "r2", targetInstanceId: "iB", responseData: {} as any });
    postTunnelActivityToChannel({ tunnelId: "t3", activity: "connected" });
    postHealthCheckToChannel({ tunnelId: "t4", healthCheckJobId: "hc1", originalInstanceId: currentInstanceId /* this is set by post fn */ });
    postHealthCheckResponseToChannel({ tunnelId: "t5", healthCheckJobId: "hc2", targetInstanceId: "iC", statusReport: {} as any });

    await delay(10); // Allow setTimeout in mock postMessage to fire

    assertSpyCalls(postMessageSpies[0], 1);
    assertEquals((postMessageSpies[0].calls[0].args[0] as BroadcastHttpRequestMessage).tunnelId, "t1");
    
    assertSpyCalls(postMessageSpies[1], 1);
    assertEquals((postMessageSpies[1].calls[0].args[0] as BroadcastHttpResponseMessage).tunnelId, "t2");
    
    assertSpyCalls(postMessageSpies[2], 1);
    assertEquals((postMessageSpies[2].calls[0].args[0] as TunnelActivityMessage).tunnelId, "t3");

    assertSpyCalls(postMessageSpies[3], 1);
    assertEquals((postMessageSpies[3].calls[0].args[0] as BroadcastHealthCheckMessage).tunnelId, "t4");
    
    assertSpyCalls(postMessageSpies[4], 1);
    assertEquals((postMessageSpies[4].calls[0].args[0] as BroadcastHealthCheckResponseMessage).tunnelId, "t5");

    postMessageSpies.forEach(s => s.restore());
  });

});
