/**
 * freee API client for expense application operations.
 *
 * Handles OAuth2 token refresh and provides typed methods
 * for interacting with freee's expense-related endpoints.
 */

const FREEE_API_BASE = "https://api.freee.co.jp";
const FREEE_TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FreeeTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** Parameters for creating an expense application line */
export interface ExpenseApplicationLineParam {
  /** Transaction date (YYYY-MM-DD) */
  transaction_date: string;
  /** Expense application line template ID (nullable) */
  expense_application_line_template_id: number | null;
  /** Amount (tax-inclusive) */
  amount: number;
  /** Description / memo */
  description?: string;
}

/** Parameters for creating an expense application */
export interface CreateExpenseApplicationParams {
  /** Company ID (事業所ID) */
  company_id: number;
  /** Title of the expense application */
  title: string;
  /** Expense application lines */
  expense_application_lines: ExpenseApplicationLineParam[];
  /** Description / overall memo */
  description?: string;
}

/** A single expense application line in the response */
export interface ExpenseApplicationLine {
  id: number;
  transaction_date: string;
  amount: number;
  description: string;
  expense_application_line_template_id: number | null;
  expense_application_line_template_name: string | null;
}

/** Expense application response from freee API */
export interface ExpenseApplication {
  id: number;
  company_id: number;
  title: string;
  description: string;
  status: string;
  total_amount: number;
  expense_application_lines: ExpenseApplicationLine[];
  deal_id: number | null;
  issue_date: string;
}

/** Account item (勘定科目) */
export interface AccountItem {
  id: number;
  name: string;
  shortcut: string | null;
  default_tax_code: number;
}

/** Expense application line template (経費科目) */
export interface ExpenseLineTemplate {
  id: number;
  name: string;
  account_item_id: number;
  account_item_name: string;
  tax_code: number;
  description: string | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class FreeeClient {
  private accessToken: string;
  private refreshToken: string;
  private clientId: string;
  private clientSecret: string;

  constructor(opts?: {
    accessToken?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
  }) {
    this.accessToken = opts?.accessToken ?? process.env.FREEE_ACCESS_TOKEN ?? "";
    this.refreshToken = opts?.refreshToken ?? process.env.FREEE_REFRESH_TOKEN ?? "";
    this.clientId = opts?.clientId ?? process.env.FREEE_CLIENT_ID ?? "";
    this.clientSecret = opts?.clientSecret ?? process.env.FREEE_CLIENT_SECRET ?? "";
  }

  // -------------------------------------------------------------------------
  // Token management
  // -------------------------------------------------------------------------

  /** Refresh the access token using the stored refresh token. */
  async refreshAccessToken(): Promise<FreeeTokens> {
    const res = await fetch(FREEE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }

    const tokens = (await res.json()) as FreeeTokens;
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    return tokens;
  }

  // -------------------------------------------------------------------------
  // Internal fetch helper
  // -------------------------------------------------------------------------

  private async apiFetch<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const url = `${FREEE_API_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    };

    let res = await fetch(url, { ...init, headers });

    // If 401, attempt one token refresh and retry
    if (res.status === 401) {
      await this.refreshAccessToken();
      headers.Authorization = `Bearer ${this.accessToken}`;
      res = await fetch(url, { ...init, headers });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`freee API error (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  // -------------------------------------------------------------------------
  // Expense Applications
  // -------------------------------------------------------------------------

  /**
   * Create an expense application (経費精算申請を作成).
   * POST /api/1/expense_applications
   */
  async createExpenseApplication(
    params: CreateExpenseApplicationParams,
  ): Promise<ExpenseApplication> {
    const body = {
      company_id: params.company_id,
      title: params.title,
      description: params.description ?? "",
      expense_application_lines: params.expense_application_lines.map((line) => ({
        transaction_date: line.transaction_date,
        amount: line.amount,
        expense_application_line_template_id: line.expense_application_line_template_id,
        description: line.description ?? "",
      })),
    };

    const data = await this.apiFetch<{ expense_application: ExpenseApplication }>(
      "/api/1/expense_applications",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    return data.expense_application;
  }

  /**
   * Get a list of expense applications (経費精算一覧を取得).
   * GET /api/1/expense_applications
   */
  async listExpenseApplications(
    companyId: number,
    opts?: { status?: string; offset?: number; limit?: number },
  ): Promise<ExpenseApplication[]> {
    const params = new URLSearchParams({
      company_id: String(companyId),
    });
    if (opts?.status) params.set("status", opts.status);
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));

    const data = await this.apiFetch<{ expense_applications: ExpenseApplication[] }>(
      `/api/1/expense_applications?${params.toString()}`,
    );
    return data.expense_applications;
  }

  // -------------------------------------------------------------------------
  // Expense Line Templates (経費科目)
  // -------------------------------------------------------------------------

  /**
   * Get expense application line templates (経費科目一覧を取得).
   * GET /api/1/expense_application_line_templates
   */
  async listExpenseLineTemplates(
    companyId: number,
  ): Promise<ExpenseLineTemplate[]> {
    const params = new URLSearchParams({
      company_id: String(companyId),
    });
    const data = await this.apiFetch<{
      expense_application_line_templates: ExpenseLineTemplate[];
    }>(`/api/1/expense_application_line_templates?${params.toString()}`);
    return data.expense_application_line_templates;
  }

  // -------------------------------------------------------------------------
  // Account Items (勘定科目)
  // -------------------------------------------------------------------------

  /**
   * Get account items (勘定科目一覧を取得).
   * GET /api/1/account_items
   */
  async listAccountItems(companyId: number): Promise<AccountItem[]> {
    const params = new URLSearchParams({
      company_id: String(companyId),
    });
    const data = await this.apiFetch<{ account_items: AccountItem[] }>(
      `/api/1/account_items?${params.toString()}`,
    );
    return data.account_items;
  }
}
