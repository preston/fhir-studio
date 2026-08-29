// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { SubscriptionHub } from './hub.js';
import type { SubscriptionNotificationEvent } from '@fhir-studio/core';

export function createSubscriptionsRouter(): Router {
  const router = express.Router();
  const hub = SubscriptionHub.getInstance();

  // 1. GET /api/sandboxes/:sandboxId/subscriptions/topics
  router.get('/api/sandboxes/:sandboxId/subscriptions/topics', (req: Request, res: Response): void => {
    res.json({ topics: hub.getTopics() });
  });

  // 2. GET /api/sandboxes/:sandboxId/subscriptions/events
  router.get('/api/sandboxes/:sandboxId/subscriptions/events', (req: Request, res: Response): void => {
    const { sandboxId } = req.params;
    res.json({ events: hub.getEvents(sandboxId) });
  });

  // 3. POST /api/sandboxes/:sandboxId/subscriptions/trigger (Test-trigger a topic notification)
  router.post('/api/sandboxes/:sandboxId/subscriptions/trigger', async (req: Request, res: Response): Promise<void> => {
    const { sandboxId } = req.params;
    const {
      topic = 'http://hl7.org/SubscriptionTopic/admission',
      resourceType = 'Encounter',
      resourceId = uuidv4(),
      webhookUrl,
    } = req.body;

    const event: SubscriptionNotificationEvent = {
      subscriptionId: `sub-${uuidv4()}`,
      topic,
      status: 'active',
      type: 'event-notification',
      eventsSinceSubscriptionStart: Math.floor(Math.random() * 20) + 1,
      timestamp: new Date().toISOString(),
      focusResource: {
        resourceType,
        id: resourceId,
        versionId: '1',
      },
    };

    await hub.broadcastEvent(sandboxId, event, webhookUrl);

    res.status(201).json({
      message: 'Subscription event triggered and broadcasted successfully.',
      event,
    });
  });

  return router;
}
