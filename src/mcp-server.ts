/**
 * MCP Server definition for freee expense operations.
 *
 * Registers tools that Claude can call to interact with freee's
 * expense application API.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FreeeClient } from "./freee-client.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "freee-expense-mcp",
    version: "0.1.0",
  });

  const freee = new FreeeClient();
  const companyId = Number(process.env.FREEE_COMPANY_ID ?? "0");

  // -----------------------------------------------------------------------
  // Tool: create_expense_application
  // -----------------------------------------------------------------------
  server.tool(
    "create_expense_application",
    "freee に経費精算申請を作成します。領収書から読み取った日付・金額・品目を元に経費申請を登録します。",
    {
      title: z.string().describe("経費精算のタイトル (例: '2024/03/01 タクシー代')"),
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
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // -----------------------------------------------------------------------
  // Tool: list_expense_applications
  // -----------------------------------------------------------------------
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
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // -----------------------------------------------------------------------
  // Tool: list_expense_line_templates
  // -----------------------------------------------------------------------
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
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // -----------------------------------------------------------------------
  // Tool: list_account_items
  // -----------------------------------------------------------------------
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
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
