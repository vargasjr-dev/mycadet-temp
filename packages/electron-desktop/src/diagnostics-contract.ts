export interface FeedbackVersionInfo {
  appName: string;
  version: string;
  commitSha: string;
  releaseChannel: string;
}

export interface FeedbackDependencies {
  app: { getAppMetrics: () => Electron.ProcessMetric[] };
  powerMonitor: { getSystemIdleTime: () => number };
  os: {
    release: () => string;
    type: () => string;
    totalmem: () => number;
    freemem: () => number;
  };
  readFile: (path: string, encoding: "utf-8") => Promise<string>;
  getVersionInfo: () => FeedbackVersionInfo;
  getLogFilePaths: () => string[];
  hasSession: () => boolean;
}
