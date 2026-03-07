import type { VercelRequest, VercelResponse } from "@vercel/node";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";
import { createHmac, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// Clients (lazy-initialised per invocation)
// ---------------------------------------------------------------------------

function getSlackClient(): WebClient {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

function getAnthropicClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ---------------------------------------------------------------------------
// freee API helpers (reuse logic from api/mcp.ts)
// ---------------------------------------------------------------------------

class FreeeClient {
  private accessToken = process.env.FREEE_ACCESS_TOKEN ?? "";
  private refreshToken = process.env.FREEE_REFRESH_TOKEN ?? "";
  private clientId = process.env.FREEE_CLIENT_ID ?? "";
  private clientSecret = process.env.FREEE_CLIENT_SECRET ?? "";
  private baseUrl = "https://api.freee.co.jp";

  private async refreshAccessToken(): Promise<void> {
    const res = await fetch(
      "https://accounts.secure.freee.co.jp/public_api/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }
    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token: string;
    };
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
  }

  async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const doFetch = () =>
      fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

    let res = await doFetch();
    if (res.status === 401) {
      await this.refreshAccessToken();
      res = await doFetch();
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`freee API error (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  async createExpenseApplication(params: Record<string, unknown>) {
    const data = await this.request<Record<string, unknown>>(
      "POST",
      "/api/1/expense_applications",
      params,
    );
    return (
      (data as Record<string, Record<string, unknown>>)
        .expense_application ?? data
    );
  }
}

// ---------------------------------------------------------------------------
// Slack request signature verification
// ---------------------------------------------------------------------------

function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  rawBody: string,
): boolean {
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (Number(timestamp) < fiveMinutesAgo) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  const expected = `v0=${hmac}`;

  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Receipt image analysis with Claude Vision
// ---------------------------------------------------------------------------

interface ReceiptData {
  date: string; // YYYY-MM-DD
  amount: number;
  description: string;
  vendor: string;
}

async function analyzeReceipt(imageBuffer: Buffer, mimeType: string): Promise<ReceiptData> {
  const anthropic = getAnthropicClient();

  const mediaType = mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  const base64 = imageBuffer.toString("base64");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          {
            type: "text",
            text: `This is a receipt image. Extract the following information and return ONLY valid JSON (no markdown, no code fences):
{
  "date": "YYYY-MM-DD format (the transaction date on the receipt)",
  "amount": <total amount as integer in JPY>,
  "description": "<brief description of what was purchased>",
  "vendor": "<store/vendor name>"
}

If you cannot read a field, use reasonable defaults:
- date: today's date
- amount: 0
- description: "unknown"
- vendor: "unknown"`,
          },
        ],
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const parsed = JSON.parse(text) as ReceiptData;
  return parsed;
}

// ---------------------------------------------------------------------------
// Download image from Slack
// ---------------------------------------------------------------------------

async function downloadSlackFile(
  url: string,
  botToken: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const mimeType = res.headers.get("content-type") ?? "image/jpeg";
  return { buffer: Buffer.from(arrayBuf), mimeType };
}

// ---------------------------------------------------------------------------
// Process a receipt message
// ---------------------------------------------------------------------------

async function processReceiptMessage(
  channelId: string,
  threadTs: string,
  files: Array<{ url_private_download: string; mimetype: string; name: string }>,
) {
  const slack = getSlackClient();
  const botToken = process.env.SLACK_BOT_TOKEN ?? "";
  const companyId = Number(process.env.FREEE_COMPANY_ID ?? "0");
  const freee = new FreeeClient();

  for (const file of files) {
    if (!file.mimetype.startsWith("image/")) continue;

    try {
      // 1. Download image from Slack
      const { buffer, mimeType } = await downloadSlackFile(
        file.url_private_download,
        botToken,
      );

      // 2. Analyze receipt with Claude Vision
      const receipt = await analyzeReceipt(buffer, mimeType);

      // 3. Create expense application in freee
      const title = `${receipt.date} ${receipt.vendor} ${receipt.description}`;
      const result = await freee.createExpenseApplication({
        company_id: companyId,
        title,
        description: `${receipt.vendor}: ${receipt.description}`,
        expense_application_lines: [
          {
            transaction_date: receipt.date,
            amount: receipt.amount,
            expense_application_line_template_id: null,
            description: `${receipt.vendor}: ${receipt.description}`,
          },
        ],
      });

      // 4. Reply in Slack thread
      const expenseId = (result as Record<string, unknown>).id;
      const totalAmount = (result as Record<string, unknown>).total_amount;

      await slack.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: [
          `freee に経費申請を登録しました`,
          `  - タイトル: ${title}`,
          `  - 金額: ${Number(totalAmount).toLocaleString()}円`,
          `  - 申請ID: ${expenseId}`,
          `  - ステータス: 下書き`,
        ].join("\n"),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Receipt processing error:", msg);
      await slack.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `経費申請の登録に失敗しました: ${msg}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Vercel Handler
// ---------------------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // --- Verify Slack signature ---
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";
  const signature = req.headers["x-slack-signature"] as string;
  const timestamp = req.headers["x-slack-request-timestamp"] as string;
  const rawBody = JSON.stringify(req.body);

  if (
    signingSecret &&
    (!signature ||
      !timestamp ||
      !verifySlackSignature(signingSecret, signature, timestamp, rawBody))
  ) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const body = req.body as Record<string, unknown>;

  // --- URL verification challenge ---
  if (body.type === "url_verification") {
    res.status(200).json({ challenge: body.challenge });
    return;
  }

  // --- Event callback ---
  if (body.type === "event_callback") {
    // Respond 200 immediately to avoid Slack retries
    res.status(200).json({ ok: true });

    const event = body.event as Record<string, unknown>;

    // Ignore bot messages to prevent loops
    if (event.bot_id || event.subtype === "bot_message") return;

    // Handle message with file attachments (receipt images)
    if (
      event.type === "message" &&
      Array.isArray(event.files) &&
      event.files.length > 0
    ) {
      const files = event.files as Array<{
        url_private_download: string;
        mimetype: string;
        name: string;
      }>;
      const imageFiles = files.filter((f) => f.mimetype.startsWith("image/"));

      if (imageFiles.length > 0) {
        await processReceiptMessage(
          event.channel as string,
          (event.ts ?? event.event_ts) as string,
          imageFiles,
        );
      }
    }

    return;
  }

  res.status(200).json({ ok: true });
}
