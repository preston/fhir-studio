// Author: Preston Lee

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { SubscriptionNotificationEvent, SubscriptionTopicDefinition } from '@fhir-studio/core';
import axios from 'axios';

interface ClientConnection {
  ws: WebSocket;
  sandboxId?: string;
  topic?: string;
  isAlive: boolean;
}

const standardTopics: SubscriptionTopicDefinition[] = [
  {
    id: 'admission',
    url: 'http://hl7.org/SubscriptionTopic/admission',
    title: 'Patient Admission Event',
    status: 'active',
    resourceTrigger: {
      description: 'Triggered whenever an inpatient encounter starts or updates to active status',
      resource: 'Encounter',
      supportedInteraction: ['create', 'update'],
    },
  },
  {
    id: 'vital-signs-recorded',
    url: 'http://hl7.org/SubscriptionTopic/vital-signs-recorded',
    title: 'Vital Signs Recorded Event',
    status: 'active',
    resourceTrigger: {
      description: 'Triggered when new vital-signs observations are posted',
      resource: 'Observation',
      supportedInteraction: ['create'],
    },
  },
  {
    id: 'medication-ordered',
    url: 'http://hl7.org/SubscriptionTopic/medication-ordered',
    title: 'Medication Order Dispatched',
    status: 'active',
    resourceTrigger: {
      description: 'Triggered when a MedicationRequest is created in draft or active status',
      resource: 'MedicationRequest',
      supportedInteraction: ['create', 'update'],
    },
  },
  {
    id: 'lab-result-ready',
    url: 'http://hl7.org/SubscriptionTopic/lab-result-ready',
    title: 'Diagnostic Lab Result Ready',
    status: 'active',
    resourceTrigger: {
      description: 'Triggered when a DiagnosticReport is completed',
      resource: 'DiagnosticReport',
      supportedInteraction: ['create', 'update'],
    },
  },
];

const recordedEvents = new Map<string, SubscriptionNotificationEvent[]>();

export class SubscriptionHub {
  private static instance: SubscriptionHub;
  private wss: WebSocketServer | null = null;
  private clients = new Set<ClientConnection>();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): SubscriptionHub {
    if (!SubscriptionHub.instance) {
      SubscriptionHub.instance = new SubscriptionHub();
    }
    return SubscriptionHub.instance;
  }

  public init(httpServer: HttpServer): void {
    if (this.wss) {
      this.close();
    }

    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/subscriptions/ws',
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      const url = new URL(req.url || '', 'http://localhost');
      const sandboxId = url.searchParams.get('sandboxId') || undefined;
      const topic = url.searchParams.get('topic') || undefined;

      const conn: ClientConnection = {
        ws,
        sandboxId,
        topic,
        isAlive: true,
      };

      this.clients.add(conn);

      // Send initial handshake message
      const handshake: SubscriptionNotificationEvent = {
        subscriptionId: `sub-${Math.random().toString(36).substring(2, 9)}`,
        topic: topic || 'all',
        status: 'active',
        type: 'handshake',
        eventsSinceSubscriptionStart: 0,
        timestamp: new Date().toISOString(),
      };
      ws.send(JSON.stringify(handshake));

      ws.on('pong', () => {
        conn.isAlive = true;
      });

      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'bind-with-token' || parsed.type === 'subscribe') {
            if (parsed.sandboxId) conn.sandboxId = parsed.sandboxId;
            if (parsed.topic) conn.topic = parsed.topic;
          }
        } catch {
          // ignore non-json messages
        }
      });

      ws.on('close', () => {
        this.clients.delete(conn);
      });
    });

    // Heartbeat ping interval
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.ws.terminate();
          this.clients.delete(client);
          continue;
        }
        client.isAlive = false;
        client.ws.ping();
      }
    }, 30_000);
    this.heartbeatInterval.unref();
  }

  public close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const client of this.clients) {
      try {
        client.ws.terminate();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    if (this.wss) {
      try {
        this.wss.close();
      } catch {
        // ignore
      }
      this.wss = null;
    }
  }

  public getTopics(): SubscriptionTopicDefinition[] {
    return standardTopics;
  }

  public getEvents(sandboxId: string): SubscriptionNotificationEvent[] {
    return recordedEvents.get(sandboxId) || [];
  }

  public async broadcastEvent(
    sandboxId: string,
    event: SubscriptionNotificationEvent,
    webhookUrl?: string,
  ): Promise<void> {
    // Record event
    const list = recordedEvents.get(sandboxId) || [];
    list.unshift(event);
    if (list.length > 50) list.pop();
    recordedEvents.set(sandboxId, list);

    // Broadcast to WebSocket clients
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        if (!client.sandboxId || client.sandboxId === sandboxId) {
          if (!client.topic || client.topic === 'all' || client.topic === event.topic) {
            client.ws.send(payload);
          }
        }
      }
    }

    // Deliver REST-hook webhook if requested
    if (webhookUrl) {
      try {
        await axios.post(webhookUrl, event, {
          headers: {
            'Content-Type': 'application/fhir+json',
            'X-FHIR-Subscription-Event': event.type,
          },
          timeout: 5000,
        });
      } catch (err: any) {
        console.warn(`Webhook delivery to ${webhookUrl} failed:`, err.message);
      }
    }
  }
}
