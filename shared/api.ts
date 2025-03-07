export interface EndpointList {
  keys: EndpointKey[];
  items: EndpointListItem[];
}

export interface EndpointListItem {
  // Non-empty in API request and response
  id?: string;

  // Non-empty in API response
  versionstamp?: string;

  setting: string;
  name: string;
  endpoint: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EndpointKey {
  // Non-empty in API request and response
  id?: string;

  // Non-empty in API response
  versionstamp?: string;
  name: string;
  parentId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
