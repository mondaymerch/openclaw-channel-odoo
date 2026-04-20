/**
 * Agent tool: odoo_search_read
 *
 * Exposes Odoo's standard `search_read` ORM method as an agent tool.
 * The agent can query any Odoo model — conversation history, record
 * details, linked contacts, etc.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { OdooClient } from "./client.js";
import { resolveAccount } from "./channel.js";

// Reuse cached clients
const toolClients = new Map<string, OdooClient>();

function getToolClient(cfg: OpenClawConfig): OdooClient {
  const account = resolveAccount(cfg);
  const key = `${account.url}:${account.db}:${account.uid}`;
  let client = toolClients.get(key);
  if (!client) {
    client = new OdooClient({
      url: account.url,
      db: account.db,
      uid: account.uid,
      password: account.password,
    });
    toolClients.set(key, client);
  }
  return client;
}

export function createOdooSearchReadTool(cfg: OpenClawConfig) {
  // Validate config at registration time
  resolveAccount(cfg);

  return () => ({
    name: "odoo_search_read",
    label: "Odoo Search & Read",
    description:
      "Search and read records from Odoo via XML-RPC. " +
      "Use this to fetch conversation history (model: openclaw.message), " +
      "record details, linked contacts, or any Odoo data. " +
      "The domain parameter uses Odoo's domain syntax: " +
      'e.g. [["model","=","crm.lead"],["res_id","=",1234]]',
    parameters: Type.Object(
      {
        model: Type.String({
          description:
            'Odoo model name, e.g. "crm.lead", "sale.order", "openclaw.message"',
        }),
        domain: Type.Array(Type.Unknown(), {
          description:
            'Odoo domain filter as a list of tuples, e.g. [["stage_id","=",1]]',
        }),
        fields: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Fields to return, e.g. ["name","stage_id","partner_id"]. Empty = all fields.',
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: 200,
            description: "Max records to return (default: 20, max: 200)",
          }),
        ),
        order: Type.Optional(
          Type.String({
            description: 'Sort order, e.g. "id desc", "create_date asc"',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (
      _toolCallId: string,
      params: {
        model: string;
        domain: unknown[];
        fields?: string[];
        limit?: number;
        order?: string;
      },
    ) => {
      const client = getToolClient(cfg);
      const records = await client.searchRead({
        model: params.model,
        domain: params.domain,
        fields: params.fields,
        limit: params.limit,
        order: params.order,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(records, null, 2),
          },
        ],
        details: undefined,
      };
    },
  });
}
