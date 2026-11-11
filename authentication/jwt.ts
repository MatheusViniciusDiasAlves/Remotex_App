/** Tokens de acesso (JWT HS256, curta duração) para contas de usuário. */
import { SignJWT, jwtVerify } from 'jose';

export interface AccessClaims {
  sub: string;
  role: 'user' | 'admin';
  email: string;
}

export class JwtService {
  private key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds = 15 * 60,
    private readonly issuer = 'remotex',
  ) {
    if (!secret || secret.length < 32) throw new Error('JWT_SECRET precisa ter pelo menos 32 caracteres');
    this.key = new TextEncoder().encode(secret);
  }

  async sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({ role: claims.role, email: claims.email, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(this.issuer)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: this.issuer, algorithms: ['HS256'] });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string') return null;
      return { sub: payload.sub, role: payload.role === 'admin' ? 'admin' : 'user', email: String(payload.email || '') };
    } catch {
      return null;
    }
  }

  get ttl(): number {
    return this.ttlSeconds;
  }
}
