/** Types for CDP network recording. */

export interface NetworkRecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
}

export interface NetworkRecordedResponse {
  status: number;
  headers: Record<string, string>;
  mimeType: string;
  body?: string;
}

export interface NetworkRecordedEntry {
  requestId: string;
  resourceType: string;
  timestamp: number;
  request: NetworkRecordedRequest;
  response?: NetworkRecordedResponse;
}

export interface ExtractedCredential {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  expires?: number;
}
