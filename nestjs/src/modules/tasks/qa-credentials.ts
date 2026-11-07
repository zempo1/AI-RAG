import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const credentialKey = (secret: string) => createHash('sha256').update(secret + '/qa-credential').digest();
export function sealQaCredential(secret: string, value?: string) {
  if (!value) return null;
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', credentialKey(secret), iv);
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(b => b.toString('base64')).join('.');
}
export function openQaCredential(secret: string, value?: string | null) {
  if (!value) return undefined;
  const [iv, tag, bytes] = value.split('.').map(s => Buffer.from(s, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', credentialKey(secret), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8');
}
