import { loadApiEnv, type EnvSource } from '../config/env';

export interface RelayProductionConfig {
  publicWebUrl: string;
  publicApiUrl: string;
  publicRelayWebSocketUrl: string;
  allowedOrigins: string[];
  ephemeralTtlSeconds: number;
  hostLeaseSeconds: number;
  maxRoomConnections: number;
  maxMessageBytes: number;
}

export function loadRelayProductionConfig(env: EnvSource = process.env): RelayProductionConfig {
  const apiEnv = loadApiEnv(env);
  if (apiEnv.mode !== 'production') throw new Error('relay production config requires hosted production mode');

  return {
    publicWebUrl: apiEnv.publicWebUrl,
    publicApiUrl: apiEnv.publicApiUrl,
    publicRelayWebSocketUrl: apiEnv.publicRelayWebSocketUrl,
    allowedOrigins: apiEnv.allowedOrigins,
    ephemeralTtlSeconds: apiEnv.relayEphemeralTtlSeconds,
    hostLeaseSeconds: apiEnv.relayHostLeaseSeconds,
    maxRoomConnections: apiEnv.relayMaxRoomConnections,
    maxMessageBytes: apiEnv.relayMaxMessageBytes,
  };
}
