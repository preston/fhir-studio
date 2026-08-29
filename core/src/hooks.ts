// Author: Preston Lee

export interface CdsServiceDefinition {
  hook: string;
  title: string;
  description: string;
  id: string;
  prefetch?: Record<string, string>;
  usageRequirements?: string;
}

export interface CdsDiscoveryResponse {
  services: CdsServiceDefinition[];
}

export interface CdsHookCardSource {
  label: string;
  url?: string;
  icon?: string;
  topic?: {
    code?: string;
    system?: string;
    display?: string;
  };
}

export interface CdsHookSystemAction {
  type: 'create' | 'update' | 'delete';
  description: string;
  resource?: unknown;
}

export interface CdsHookCardSuggestion {
  label: string;
  uuid?: string;
  isRecommended?: boolean;
  actions?: Array<{
    type: 'create' | 'update' | 'delete';
    description: string;
    resource?: unknown;
  }>;
}

export interface CdsHookCardOverrideReason {
  code: {
    system?: string;
    code?: string;
    display?: string;
  };
  userComment?: string;
}

export interface CdsHookCard {
  uuid?: string;
  summary: string;
  detail?: string;
  indicator: 'info' | 'warning' | 'critical';
  source: CdsHookCardSource;
  suggestions?: CdsHookCardSuggestion[];
  selectionBehavior?: 'at-most-one' | 'any';
  overrideReasons?: CdsHookCardOverrideReason[];
  systemActions?: CdsHookSystemAction[];
  links?: Array<{
    label: string;
    url: string;
    type: 'absolute' | 'smart';
    appContext?: string;
  }>;
}

export interface CdsHookResponse {
  cards: CdsHookCard[];
  systemActions?: CdsHookSystemAction[];
}

export interface CdsHookFeedbackPayload {
  card: string;
  outcome: 'accepted' | 'overridden' | 'seen' | 'ignored';
  acceptedSuggestions?: Array<{
    id?: string;
  }>;
  overrideReason?: {
    reason?: {
      system?: string;
      code?: string;
      display?: string;
    };
    userComment?: string;
  };
  outcomeTimestamp: string;
}

export interface CdsServiceEndpointSummary {
  id: string;
  sandboxId: string;
  name: string;
  url: string;
  servicesJson: CdsServiceDefinition[];
  createdAt: string;
  updatedAt: string;
}

