import crypto from 'crypto';
import type { Express, Request, Response } from 'express';

export interface WebhookRawBodyRequest extends Request {
  rawBody?: Buffer;
}

function timingSafeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyMetaSignature(rawBody: Buffer, signatureHeader: string, appSecret: string): boolean {
  if (!signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const receivedHex = signatureHeader.slice('sha256='.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(receivedHex)) {
    return false;
  }

  const expectedHex = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  const receivedBuf = Buffer.from(receivedHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(receivedBuf, expectedBuf);
}

export function registerInstagramWebhook(app: Express) {
  // Dedicated Meta Instagram Webhooks endpoint (isolated from /api/auth/instagram/callback)
  app.get(['/api/webhooks/instagram', '/api/webhooks/instagram/'], (req: Request, res: Response) => {
    const expectedToken = process.env.META_VERIFY_TOKEN;
    if (!expectedToken || !expectedToken.trim()) {
      return res.status(503).send('META_VERIFY_TOKEN is not configured on the server.');
    }

    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');

    if (mode === 'subscribe' && challenge && timingSafeEqualUtf8(token, expectedToken)) {
      return res.status(200).type('text/plain').send(challenge);
    }

    return res.status(403).send('Instagram webhook verification failed.');
  });

  app.post(['/api/webhooks/instagram', '/api/webhooks/instagram/'], (req: WebhookRawBodyRequest, res: Response) => {
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret || !appSecret.trim()) {
      return res.status(503).json({ error: 'META_APP_SECRET is not configured on the server.' });
    }

    const signatureHeader = req.get('x-hub-signature-256') || '';
    if (!Buffer.isBuffer(req.rawBody) || !verifyMetaSignature(req.rawBody, signatureHeader, appSecret)) {
      return res.status(403).json({ error: 'Invalid X-Hub-Signature-256 webhook signature.' });
    }

    const body = req.body as { object?: string; entry?: Array<{ id?: string; time?: number }> } | undefined;
    if (body?.object === 'instagram' && Array.isArray(body.entry)) {
      console.log(`Verified Instagram webhook batch (${body.entry.length} entry item(s)).`);
    }

    return res.status(200).json({ received: true });
  });
}
