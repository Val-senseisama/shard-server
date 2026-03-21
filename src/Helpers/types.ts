export type ObjectType = {
  [index: string]: any;
};

export type AuditTrailType = {
  userId: string;
  task: string;
  details: string;
};

export type LogType = {
  task?: string;
  errorMessage: string;
  timestamp: string;
};
