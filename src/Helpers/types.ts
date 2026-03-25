export type ObjectType = {
  [index: string]: any;
};

export type AuditTrailType = {
  userId: string;
  task: string;
  details: string;
};

export type LogType = {
  task: string;
  resolver?: string;
  errorMessage: string;
  stack?: string;
  userId?: string;
  severity: "low" | "medium" | "high" | "critical";
  metadata?: Record<string, any>;
  timestamp: string;
};
