/**
 * Protocolo de sinalização RemoteX (WebSocket, JSON).
 *
 * O servidor autentica dispositivos (token de dispositivo), mantém presença online/offline,
 * intermedia pedidos de conexão por ID e retransmite mensagens "relay" entre os dois lados de
 * uma sessão. O conteúdo de "relay" (autenticação ponta a ponta, SDP, ICE) não é interpretado
 * pelo servidor — apenas encaminhado com limites de tamanho e taxa.
 */
import type { PermissionSet } from '@remotex/security/permissions';
import type { ScryptParams } from '@remotex/auth/password';

export type DeviceKind = 'host' | 'client';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ClientToServer =
  | { t: 'hello'; deviceId: string; token: string; kind: DeviceKind; name?: string; platform?: string; version?: string; protocol: number }
  | { t: 'connect'; reqId: string; hostId: string; clientNonce: string }
  | { t: 'relay'; sessionId: string; payload: RelayPayload }
  | { t: 'session.state'; sessionId: string; state: SessionState; authMethod?: AuthMethod; reason?: string }
  | { t: 'session.end'; sessionId: string; reason?: string }
  | { t: 'presence.query'; ids: string[] }
  | { t: 'ping' };

export type SessionState = 'authorizing' | 'authorized' | 'rejected' | 'active' | 'ended';

export interface PeerInfo {
  id: string;
  name: string;
  platform: string;
  ip?: string;
  account?: string | null;
}

export type ServerToClient =
  | { t: 'hello.ok'; deviceId: string; serverTime: number; name: string }
  | { t: 'error'; code: ErrorCode; message: string; reqId?: string; sessionId?: string }
  | { t: 'session.created'; reqId: string; sessionId: string; host: PeerInfo; iceServers: IceServer[] }
  | { t: 'session.incoming'; sessionId: string; client: PeerInfo; clientNonce: string; iceServers: IceServer[] }
  | { t: 'relay'; sessionId: string; payload: RelayPayload }
  | { t: 'session.ended'; sessionId: string; reason: string }
  | { t: 'presence'; statuses: Record<string, boolean> }
  | { t: 'pong'; serverTime: number };

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'HOST_NOT_FOUND'
  | 'HOST_OFFLINE'
  | 'RATE_LIMITED'
  | 'SESSION_NOT_FOUND'
  | 'SELF_CONNECT'
  | 'TOO_LARGE'
  | 'REVOKED'
  | 'INTERNAL';

export type AuthMethod = 'password' | 'device' | 'approval';

/** Mensagens ponta a ponta entre celular e computador (retransmitidas pelo servidor). */
export type RelayPayload =
  | {
      k: 'auth.hello';
      methods: AuthMethod[];
      hostName: string;
      hostPublicKey: string;
      hostSignature: string;
      hostNonce: string;
      password?: { salt: string; params: ScryptParams };
      lockedForMs?: number;
    }
  | { k: 'auth.password'; proof: string; clientPublicKey: string; clientSignature: string; clientName: string }
  | { k: 'auth.device'; clientPublicKey: string; clientSignature: string; clientName: string }
  | { k: 'auth.approval'; clientPublicKey: string; clientSignature: string; clientName: string }
  | { k: 'auth.pending' }
  | {
      k: 'auth.result';
      ok: boolean;
      permissions?: PermissionSet;
      reason?: string;
      code?: 'BAD_PASSWORD' | 'REJECTED' | 'LOCKED' | 'TIMEOUT' | 'DISABLED' | 'BAD_SIGNATURE' | 'METHOD_UNAVAILABLE' | 'BUSY';
      retry?: boolean;
      trusted?: boolean;
    }
  | { k: 'sdp'; type: 'offer' | 'answer'; sdp: string }
  | { k: 'ice'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }
  | { k: 'bye'; reason?: string };

export const MAX_SIGNAL_MESSAGE_BYTES = 64 * 1024;
