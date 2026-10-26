// Author: Preston Lee

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type {
  SubscriptionNotificationEvent,
  SubscriptionTopicDefinition,
} from '@fhir-studio/core';
import { requestPublicBuffer } from '../http/public-request.js';
import type { OidcBffConfig } from '../auth/sso_config.js';
import { isSessionExpired, resolveSessionFromRequest } from '../authentication/session.js';
import { sandboxAccess } from '../hosted/access.js';
import { getPrisma } from '../db/prisma.js';
import { loadEffectivePermissions } from '../authorization/effectivePermissions.js';

interface ClientConnection {
  ws: WebSocket;
  sandboxId: string;
  topic?: string;
  isAlive: boolean;
  authorize: () => Promise<void>;
}

const standardTopics: SubscriptionTopicDefinition[] = [
  {
    id: 'admission',
    url: 'http://hl7.org/SubscriptionTopic/admission',
    title: 'Patient Admission Event',
    status: 'active',
    resourceTrigger: {
      description:
        'Triggered whenever an inpatient encounter starts or updates to active status',
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
      description:
        'Triggered when a MedicationRequest is created in draft or active status',
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

  public init(httpServer: HttpServer, oidc: OidcBffConfig): void {
    if (this.wss) {
      this.close();
    }

    const authorizations = new WeakMap<IncomingMessage, { sandboxId: string; check: () => Promise<void> }>();
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/subscriptions/ws',
      verifyClient: (info, done) => {
        void (async () => {
          const trustedOrigins = new Set([
            ...oidc.corsOrigins,
            new URL(oidc.redirectUrl).origin,
            new URL(oidc.uiBaseUrl).origin,
          ]);
          if (!trustedOrigins.has(info.origin)) return false;
          const cookies: Record<string, string> = {};
          for (const item of (info.req.headers.cookie || '').split(';')) {
            const separator = item.indexOf('=');
            if (separator > 0)
              cookies[item.slice(0, separator).trim()] = decodeURIComponent(
                item.slice(separator + 1),
              );
          }
          const session = await resolveSessionFromRequest({ cookies }, oidc);
          const sandboxId = new URL(
            info.req.url || '',
            'http://localhost',
          ).searchParams.get('sandboxId');
          if (!session || !sandboxId) return false;
          const permissions = await loadEffectivePermissions(
            getPrisma(),
            session.user.id,
          );
          const sandbox = await sandboxAccess(
            session.user.id,
            sandboxId,
            false,
            permissions.global_manage,
          );
          authorizations.set(info.req, {
            sandboxId: sandbox.id,
            check: async () => {
              const db = getPrisma();
              const current = await db.session.findUnique({
                where: { id: session.session.id },
                include: { user: true },
              });
              if (!current || current.userId !== session.user.id || current.user.isSuspended || isSessionExpired(current))
                throw new Error('Subscription session is no longer authorized.');
              const permissions = await loadEffectivePermissions(db, session.user.id);
              const currentSandbox = await sandboxAccess(session.user.id, sandboxId, false, permissions.global_manage);
              if (currentSandbox.id !== sandbox.id) throw new Error('Subscription sandbox was replaced.');
            },
          });
          return true;
        })().then(
          (allowed) => done(allowed, allowed ? undefined : 403),
          () => done(false, 403),
        );
      },
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      const authorization = authorizations.get(req);
      if (!authorization) {
        ws.close(1008, 'Subscription authorization required.');
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const topic = url.searchParams.get('topic') || undefined;

      const conn: ClientConnection = {
        ws,
        sandboxId: authorization.sandboxId,
        topic,
        isAlive: true,
        authorize: authorization.check,
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
          if (
            parsed.type === 'bind-with-token' ||
            parsed.type === 'subscribe'
          ) {
            if (parsed.sandboxId && parsed.sandboxId !== conn.sandboxId) {
              ws.close(1008, 'Sandbox binding cannot change.');
              return;
            }
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
        if (client.sandboxId === sandboxId) {
          if (
            !client.topic ||
            client.topic === 'all' ||
            client.topic === event.topic
          ) {
            try { await client.authorize(); }
            catch {
              client.ws.close(1008, 'Subscription access was revoked.');
              this.clients.delete(client);
              continue;
            }
            if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
          }
        }
      }
    }

    // Deliver REST-hook webhook if requested
    if (webhookUrl) {
      try {
        await requestPublicBuffer(webhookUrl, {
          method: 'POST',
          body: event,
          headers: {
            'Content-Type': 'application/fhir+json',
            'X-FHIR-Subscription-Event': event.type,
          },
          timeoutMs: 5000,
          maxBytes: 64 * 1024,
          followRedirects: false,
        });
      } catch (error: unknown) {
        console.warn('Subscription webhook delivery failed:', error instanceof Error ? error.message : 'Unknown delivery error');
      }
    }
  }
}
