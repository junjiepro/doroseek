export interface EndpointList {
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
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
