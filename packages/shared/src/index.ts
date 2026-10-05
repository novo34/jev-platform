export type ServiceName = "web" | "api" | "worker";

export interface HealthStatus {
  service: ServiceName;
  status: "ok";
  timestamp: string;
}

export function createHealthStatus(service: ServiceName): HealthStatus {
  return {
    service,
    status: "ok",
    timestamp: new Date().toISOString()
  };
}
