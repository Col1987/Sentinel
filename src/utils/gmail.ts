import { google } from 'googleapis';
import { config } from 'dotenv';

config();

const POLL_INTERVAL_MS          = 3_000;
const POLL_TIMEOUT_MS           = 30_000;
const ORDER_POLL_TIMEOUT_MS     = 60_000;

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// Recursively walks a Gmail message payload to find the first HTML or plain-text part.
function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  if (Array.isArray(payload.parts)) {
    // Prefer HTML part so href attributes are present
    const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) return decodeBase64Url(htmlPart.body.data);
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

function extractVerificationLink(body: string): string | null {
  const patterns = [
    // href attributes (HTML emails — double or single quoted)
    /href="(https?:\/\/[^"]*(?:verifyEmail|oobCode)[^"]*)"/i,
    /href='(https?:\/\/[^']*(?:verifyEmail|oobCode)[^']*)'/i,
    // Plain-text fallback
    /(https?:\/\/\S*(?:verifyEmail|oobCode)\S*)/i,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1]) {
      // HTML entities in href values must be decoded before navigation
      return match[1].replace(/&amp;/g, '&');
    }
  }
  return null;
}

function extractTrackingLink(body: string): string | null {
  const patterns = [
    // href="..." on an <a> tag, followed within 500 chars by "Track Your Order"
    /href="(https?:\/\/[^"]+)"[\s\S]{0,500}?Track Your Order/i,
    // href on a line that also contains /track (common in plain-text fallbacks)
    /href="(https?:\/\/[^"]*\/track[^"]*)"/i,
    // Plain-text URL containing /track
    /(https?:\/\/\S*\/track\S*)/i,
  ];
  for (const p of patterns) {
    const m = body.match(p);
    if (m?.[1]) return m[1].replace(/&amp;/g, '&');
  }
  return null;
}

/**
 * Polls the sentinelqa2026@gmail.com inbox for a verification email from
 * no-reply@juelhaus.co.za that arrived after `sentAfter`.
 *
 * Returns the verification link extracted from the email body, or null if no
 * email arrives within 30 seconds.
 *
 * Requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in .env.
 */
export async function getLatestVerificationEmail(sentAfter: Date): Promise<string | null> {
  const clientId     = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Gmail credentials missing — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, ' +
      'GMAIL_REFRESH_TOKEN in .env',
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Gmail `after:` operator takes Unix seconds (not milliseconds)
  const afterSeconds = Math.floor(sentAfter.getTime() / 1000);
  const query = `from:no-reply@juelhaus.co.za after:${afterSeconds}`;

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const listResp = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 5,
    });

    const messages = listResp.data.messages ?? [];

    if (messages.length > 0) {
      const msgResp = await gmail.users.messages.get({
        userId: 'me',
        id: messages[0].id!,
        format: 'full',
      });

      const body = extractBody(msgResp.data.payload);
      const link = extractVerificationLink(body);
      if (link) return link;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
  }

  return null;
}

/**
 * Polls the sentinelqa2026@gmail.com inbox for an order confirmation email from
 * no-reply@juelhaus.co.za that arrived after `sentAfter` and contains a
 * "Track Your Order" button link.
 *
 * Returns the href from the "Track Your Order" button, or null if no matching
 * email arrives within 60 seconds.
 *
 * Requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in .env.
 */
export async function getLatestOrderConfirmationEmail(sentAfter: Date): Promise<string | null> {
  const clientId     = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Gmail credentials missing — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, ' +
      'GMAIL_REFRESH_TOKEN in .env',
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const afterSeconds = Math.floor(sentAfter.getTime() / 1000);
  // Use sender + timestamp only; body-check differentiates from verification emails
  const query = `from:no-reply@juelhaus.co.za after:${afterSeconds}`;

  const deadline = Date.now() + ORDER_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const listResp = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 10,
    });

    for (const msg of listResp.data.messages ?? []) {
      const msgResp = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'full',
      });
      const body = extractBody(msgResp.data.payload);
      const link = extractTrackingLink(body);
      if (link) return link;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
  }

  return null;
}
