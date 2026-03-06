import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// freee API Client
// ---------------------------------------------------------------------------

interface FreeeTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  created_at: number;
}

class FreeeClient {
  private accessToken: string;
  private refreshToken: string;
  private clientId: string;
  private clientSecret: string;
  private baseUrl = "https://api.freee.co.jp";

  constructor() {
    this.accessToken = process.env.FREEE_ACCESS_TOKEN ?? "";
    this.refreshToken = process.env.FREEE_REFRESH_TOKEN ?? "";
    this.clientId = process.env.FREEE_CLIENT_ID ?? "";
    this.clientSecret = process.env.FREEE_CLIENT_SECRET ?? "";
  }

  private async refreshAccessToken(): Promise<FreeeTokens> {
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

    const tokens = (await res.json()) as FreeeTokens;
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    return tokens;
  }

  async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res;
    };

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

  async createExpenseApplication(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await this.request<Record<string, unknown>>(
      "POST",
      "/api/1/expense_applications",
      params,
    );
    return (data as Record<string, Record<string, unknown>>)
      .expense_application ?? data;
  }

  async listExpenseApplications(
    companyId: number,
    opts?: { status?: string; limit?: number },
  ): Promise<Record<string, unknown>[]> {
    const query = new URLSearchParams({ company_id: String(companyId) });
    if (opts?.status) query.set("status", opts.status);
    if (opts?.limit) query.set("limit", String(opts.limit));

    const data = await this.request<Record<string, unknown>>(
      "GET",
      `/api/1/expense_applications?${query}`,
    );
    return (data as Record<string, Record<string, unknown>[]>)
      .expense_applications ?? [];
  }

  async listExpenseLineTemplates(
    companyId: number,
  ): Promise<Record<string, unknown>[]> {
    const data = await this.request<Record<string, unknown>>(
      "GET",
      `/api/1/expense_application_line_templates?company_id=${companyId}`,
    );
    return (data as Record<string, Record<string, unknown>[]>)
      .expense_application_line_templates ?? [];
  }

  async listAccountItems(
    companyId: number,
  ): Promise<Record<string, unknown>[]> {
    const data = await this.request<Record<string, unknown>>(
      "GET",
      `/api/1/account_items?company_id=${companyId}`,
    );
    return (data as Record<string, Record<string, unknown>[]>)
      .account_items ?? [];
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "freee-expense-mcp",
    version: "0.1.0",
  });

  const freee = new FreeeClient();
  const companyId = Number(process.env.FREEE_COMPANY_ID ?? "0");

  server.tool(
    "create_expense_application",
    "freee に経費精算申請を作成します。領収書から読み取った日付・金額・品目を元に経費申請を登録します。",
    {
      title: z
        .string()
        .describe("経費精算のタイトル (例: '2024/03/01 タクシー代')"),
      transaction_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("発生日 (YYYY-MM-DD形式)"),
      amount: z.number().positive().describe("金額（税込合計）"),
      expense_line_template_id: z
        .number()
        .nullable()
        .describe("経費科目テンプレートID (不明な場合は null)"),
      description: z
        .string()
        .optional()
        .describe("備考 (支払先・内容など)"),
    },
    async (params) => {
      try {
        const result = await freee.createExpenseApplication({
          company_id: companyId,
          title: params.title,
          description: params.description,
          expense_application_lines: [
            {
              transaction_date: params.transaction_date,
              amount: params.amount,
              expense_application_line_template_id:
                params.expense_line_template_id,
              description: params.description,
            },
          ],
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  expense_application_id: result.id,
                  title: result.title,
                  total_amount: result.total_amount,
                  status: result.status,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "list_expense_applications",
    "freee の経費精算申請一覧を取得します。",
    {
      status: z
        .enum(["draft", "in_progress", "approved", "rejected"])
        .optional()
        .describe("ステータスで絞り込み"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("取得件数 (最大100)"),
    },
    async (params) => {
      try {
        const results = await freee.listExpenseApplications(companyId, {
          status: params.status,
          limit: params.limit,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                results.map((r) => ({
                  id: r.id,
                  title: r.title,
                  total_amount: r.total_amount,
                  status: r.status,
                  issue_date: r.issue_date,
                })),
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "list_expense_line_templates",
    "freee で利用可能な経費科目テンプレート一覧を取得します。経費申請時の科目ID特定に使用します。",
    {},
    async () => {
      try {
        const templates = await freee.listExpenseLineTemplates(companyId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                templates.map((t) => ({
                  id: t.id,
                  name: t.name,
                  account_item_name: t.account_item_name,
                })),
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "list_account_items",
    "freee の勘定科目一覧を取得します。",
    {},
    async () => {
      try {
        const items = await freee.listAccountItems(companyId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                items.map((i) => ({
                  id: i.id,
                  name: i.name,
                  shortcut: i.shortcut,
                })),
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Vercel Handler
// ---------------------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const server = createMcpServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP handler error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
}
