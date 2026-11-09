import { z } from "zod";
import type { Params, SchedClient, SchedResponse } from "./client.js";

export type ToolAccess = "read" | "write";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  access: ToolAccess;
  destructive?: boolean;
  idempotent?: boolean;
  inputSchema: z.ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (client: SchedClient, args: any) => Promise<SchedResponse>;
}

const DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const dateTime = (what: string) =>
  z.string().regex(DATETIME, `${what} must be "YYYY-MM-DD HH:MM" in the event's local time`);

const since = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("Unix epoch seconds. Only return items modified after this time.");

const csvList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (Array.isArray(v) ? v.join(",") : v));

const yn = (v: boolean | undefined) => (v === undefined ? undefined : v ? "Y" : "N");
const oneZero = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);

const ROLES = ["attendee", "speaker", "artist", "sponsor", "exhibitor"] as const;

/**
 * Custom fields are sent as top-level params. Refuse any name that is a real
 * parameter, so custom_fields cannot bypass schema validation or clobber the key.
 */
function customFields(fields: Record<string, string> | undefined, reserved: ReadonlySet<string>): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (reserved.has(k) || k === "__proto__") throw new Error(`custom_fields cannot use the reserved name "${k}"`);
    out[k] = v;
  }
  return out;
}

// ---------- session fields shared by add/mod ----------
const sessionFields = {
  name: z.string().max(120).optional().describe("Session title (max 120 chars)."),
  session_start: dateTime("session_start").optional(),
  session_end: dateTime("session_end").optional(),
  session_type: z.string().max(32).optional().describe("Category/track. Created if it does not exist."),
  session_subtype: z.string().max(32).optional(),
  description: z.string().max(8192).optional().describe("Plain text; <a> links are allowed."),
  media_url: z.string().url().max(250).optional().describe("HTTPS URL to a video or image."),
  venue: z.string().max(80).optional(),
  address: z.string().max(250).optional(),
  tags: csvList.describe("Comma separated tags, or an array."),
  seats: z.union([z.string(), z.number()]).optional().describe("Seat capacity."),
  rsvp_url: z.string().max(1024).optional(),
  ticket_message: z.string().max(1024).optional(),
  active: z.boolean().optional().describe("false hides the session."),
  custom_fields: z
    .record(z.string(), z.string())
    .optional()
    .describe("Custom session fields, keyed by the custom field's API name."),
};

const SESSION_RESERVED: ReadonlySet<string> = new Set([
  ...Object.keys(sessionFields),
  "session_key",
  "api_key",
  "format",
]);

function sessionParams(args: Record<string, unknown>): Params {
  const { custom_fields, active, ...rest } = args as { custom_fields?: Record<string, string>; active?: boolean };
  return { ...(rest as Params), active: yn(active), ...customFields(custom_fields, SESSION_RESERVED) };
}

// ---------- user fields shared by add/mod ----------
const userFields = {
  email: z.string().email().optional(),
  phone: z.string().optional(),
  privacy: z.boolean().optional().describe("true hides the profile from the public directory."),
  role: z.enum(ROLES).optional(),
  sessions: csvList.describe("Session keys/IDs to link (comma separated or array)."),
  full_name: z.string().optional(),
  about: z.string().max(8192).optional(),
  avatar: z.string().url().max(1024).optional().describe("Public URL to a gif/jpg/png."),
  location: z.string().optional(),
  company: z.string().optional(),
  position: z.string().optional(),
  booth: z.string().optional().describe("Exhibitors only."),
  tags: csvList,
};

export const TOOLS: ToolDef[] = [
  // ======================= READ =======================
  {
    name: "sched_get_event",
    title: "Get event info",
    access: "read",
    description:
      "Event metadata: title, URL, dates, timezone, venues, session/people counts and privacy settings. Useful first call to discover valid venue/type names.",
    inputSchema: {
      modify_date: since.describe("Unix epoch seconds; return only if modified since."),
      include_ui_strings: z
        .boolean()
        .optional()
        .describe("Include the several hundred UI translation strings (lang, strings). Off by default."),
    },
    run: async (c, a) => {
      const res = await c.call("site/sync", { modify_date: a.modify_date });
      if (a.include_ui_strings || !res.json || typeof res.json !== "object" || Array.isArray(res.json)) return res;
      const { lang: _lang, strings: _strings, ...rest } = res.json as Record<string, unknown>;
      return { ...res, json: rest };
    },
  },
  {
    name: "sched_list_sessions",
    title: "List sessions",
    access: "read",
    description:
      "List public (active) sessions with their basic fields as JSON. Hidden sessions are not included; use sched_export_sessions to see every session including hidden ones, or include_deleted for only the inactive ones.",
    inputSchema: {
      since,
      include_deleted: z
        .boolean()
        .optional()
        .describe("true returns only inactive sessions. Sched treats hidden (active=false) and deleted sessions the same."),
      custom_data: z.boolean().optional().describe("Include custom session fields."),
    },
    run: (c, a) =>
      c.call("session/list", {
        format: "json",
        since: a.since,
        status: a.include_deleted ? "del" : undefined,
        custom_data: a.custom_data ? "Y" : undefined,
      }),
  },
  {
    name: "sched_export_sessions",
    title: "Export sessions",
    access: "read",
    description:
      "Full session export (speakers, attendee counts, address, etc.) with field selection and paging. Includes hidden sessions; check the active field.",
    inputSchema: {
      since,
      fields: csvList.describe("Ordered list of fields to include."),
      page: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(1000).optional().describe("Rows per page (default 1000)."),
      strip_html: z.boolean().optional(),
      custom_data: z.boolean().optional(),
    },
    run: (c, a) =>
      c.call("session/export", {
        format: "json",
        since: a.since,
        fields: a.fields,
        page: a.page,
        limit: a.limit,
        strip_html: a.strip_html ? "Y" : undefined,
        custom_data: a.custom_data ? "Y" : undefined,
      }),
  },
  {
    name: "sched_count_sessions",
    title: "Count sessions",
    access: "read",
    description: "Total number of sessions.",
    inputSchema: { since, include_deleted: z.boolean().optional() },
    run: (c, a) => c.call("session/count", { since: a.since, status: a.include_deleted ? "del" : undefined }),
  },
  {
    name: "sched_get_session_seats",
    title: "Get session attendees",
    access: "read",
    description: "Attendees and/or waitlist of one session, including check-in timestamps if used.",
    inputSchema: {
      id: z.string().optional().describe("Sched session ID."),
      key: z.string().optional().describe("Your session_key. Provide id or key."),
      type: z.enum(["attendance", "waitlist", "all"]).optional(),
    },
    run: (c, a) => {
      if (!a.id && !a.key) throw new Error("Provide either id or key");
      return c.call("session/seats", { id: a.id, key: a.key, type: a.type, format: "json" });
    },
  },
  {
    name: "sched_list_users",
    title: "List users",
    access: "read",
    description: "All users (attendees, speakers, etc.) of the event.",
    inputSchema: {
      fields: csvList.describe(
        "Fields to return. Default: username,name,phone,email,joined,lastactive,avatar,company,position,location.",
      ),
    },
    run: (c, a) => c.call("user/list", { format: "json", fields: a.fields }),
  },
  {
    name: "sched_get_user",
    title: "Get user",
    access: "read",
    description: "Look up a single user by username, email, name or id.",
    inputSchema: {
      by: z.enum(["username", "email", "name", "id"]).default("username"),
      term: z.string().min(1),
      fields: csvList,
    },
    run: (c, a) => c.call("user/get", { by: a.by, term: a.term, fields: a.fields, format: "json" }),
  },
  {
    name: "sched_list_user_activity",
    title: "List user activity",
    access: "read",
    description: "Username and last-active time for every user (CSV).",
    inputSchema: {},
    run: (c) => c.call("user/active"),
  },
  {
    name: "sched_list_user_sessions",
    title: "List attendee schedules",
    access: "read",
    description: "Every attendee with the sessions they selected.",
    inputSchema: {},
    run: (c) => c.call("user/sessions", { format: "json" }),
  },
  {
    name: "sched_list_all_schedules",
    title: "List all schedules",
    access: "read",
    description: "All attendees' personal schedules as JSON.",
    inputSchema: {},
    run: (c) => c.call("going/all"),
  },
  {
    name: "sched_export_role",
    title: "Export users by role",
    access: "read",
    description: "Export everyone with a role (e.g. all speakers or sponsors).",
    inputSchema: {
      role: z.enum(ROLES),
      fields: csvList.describe(
        "Default: name,email,company,position,location,about,url,avatar,tags. Also: id,username,phone,sessions,privacy_mode,lastactive.",
      ),
      featured: z.boolean().optional().describe("Only featured users (not for attendees)."),
      strip_html: z.boolean().optional(),
    },
    run: (c, a) =>
      c.call("role/export", {
        role: a.role,
        format: "json",
        fields: a.fields,
        featured: a.featured ? "y" : undefined,
        strip_html: a.strip_html ? "Y" : undefined,
      }),
  },
  {
    name: "sched_list_tags",
    title: "List tags",
    access: "read",
    description: "All people tags (tags applied to users) with how many users carry each.",
    inputSchema: {},
    run: (c) => c.call("tag/people/get"),
  },

  // ======================= WRITE =======================
  {
    name: "sched_add_session",
    title: "Add session",
    access: "write",
    description:
      "Create a session. Note: the first successful add on a brand-new event clears Sched's demo data.",
    inputSchema: {
      session_key: z.string().regex(/^[A-Za-z0-9]{1,32}$/, "alphanumeric, max 32").describe("Your unique ID for the session."),
      ...sessionFields,
      name: z.string().min(1).max(120),
      session_start: dateTime("session_start"),
      session_end: dateTime("session_end"),
      session_type: z.string().min(1).max(32).describe("Category/track used to filter sessions. Created if it does not exist."),
    },
    run: (c, a) => c.call("session/add", sessionParams(a)),
  },
  {
    name: "sched_update_session",
    title: "Update session",
    access: "write",
    idempotent: true,
    description: "Modify an existing session. Only provided fields change.",
    inputSchema: { session_key: z.string().min(1).max(32), ...sessionFields },
    run: (c, a) => c.call("session/mod", sessionParams(a)),
  },
  {
    name: "sched_delete_session",
    title: "Delete session",
    access: "write",
    destructive: true,
    idempotent: true,
    description:
      "Deactivate a session. It is hidden and its page shows [CANCELLED]; data is kept. This is the same state as active=false, so sched_update_session with active=true brings it back.",
    inputSchema: { session_key: z.string().min(1).max(32) },
    run: (c, a) => c.call("session/del", { session_key: a.session_key }),
  },
  {
    name: "sched_add_user",
    title: "Add user",
    access: "write",
    description:
      "Create a user. Fails if the email already has a Sched account. The response contains the generated password.",
    inputSchema: {
      username: z.string().optional().describe("Provide username or email."),
      password: z.string().optional().describe("Random if omitted."),
      send_email: z.boolean().optional().describe("Send the welcome email."),
      ...userFields,
    },
    run: (c, a) => {
      if (!a.username && !a.email) throw new Error("Provide username or email");
      return c.call("user/add", {
        ...a,
        privacy: oneZero(a.privacy),
        send_email: oneZero(a.send_email),
      });
    },
  },
  {
    name: "sched_update_user",
    title: "Update user",
    access: "write",
    idempotent: true,
    description:
      "Modify a user. For non-attendee roles, sessions overwrites the linked list; for attendees it adds. An empty tags string clears all tags.",
    inputSchema: {
      uid: z.string().optional().describe("Sched user ID. Provide uid or username."),
      username: z.string().optional(),
      password: z.string().optional().describe("Required when changing the username."),
      ...userFields,
    },
    run: (c, a) => {
      if (!a.uid && !a.username) throw new Error("Provide uid or username");
      return c.call("user/mod", { ...a, privacy: oneZero(a.privacy) });
    },
  },
  {
    name: "sched_set_user_avatar",
    title: "Set user avatar",
    access: "write",
    idempotent: true,
    description: "Set a user's avatar from an image URL.",
    inputSchema: { username: z.string().min(1), avatar: z.string().url() },
    run: (c, a) => c.call("user/avatar", { username: a.username, avatar: a.avatar }),
  },
  {
    name: "sched_add_role",
    title: "Add role to user",
    access: "write",
    description: "Give a user a role, optionally linking them to sessions (e.g. make someone a speaker).",
    inputSchema: {
      username: z.string().min(1),
      role: z.enum(ROLES),
      sessions: csvList.describe("Session keys to link."),
      send_email: z.boolean().optional(),
    },
    run: (c, a) =>
      c.call("role/add", { username: a.username, role: a.role, sessions: a.sessions, send_email: oneZero(a.send_email) }),
  },
  {
    name: "sched_remove_role",
    title: "Remove role from user",
    access: "write",
    destructive: true,
    description: "Remove a role from a user. Without sessions it is removed from all their sessions.",
    inputSchema: { username: z.string().min(1), role: z.enum(ROLES), sessions: csvList.describe("Session IDs.") },
    run: (c, a) => c.call("role/del", { username: a.username, role: a.role, sessions: a.sessions }),
  },
  {
    name: "sched_add_tag",
    title: "Add tag",
    access: "write",
    description: "Create a people tag (a tag that can be applied to users).",
    inputSchema: {
      name: z.string().min(1).max(32),
      slug: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    },
    run: (c, a) => c.call("tag/people/add", { name: a.name, slug: a.slug, ...metadataParams(a.metadata) }),
  },
  {
    name: "sched_update_tag",
    title: "Update tag",
    access: "write",
    idempotent: true,
    description: "Rename a people tag or change its slug/metadata.",
    inputSchema: {
      id: z.union([z.string(), z.number()]),
      name: z.string().max(32).optional(),
      slug: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    },
    run: (c, a) => c.call("tag/people/mod", { id: a.id, name: a.name, slug: a.slug, ...metadataParams(a.metadata) }),
  },
  {
    name: "sched_delete_tag",
    title: "Delete tag",
    access: "write",
    destructive: true,
    description: "Delete a people tag.",
    inputSchema: { id: z.union([z.string(), z.number()]) },
    run: (c, a) => c.call("tag/people/del", { id: a.id }),
  },
];

function metadataParams(meta: Record<string, string> | undefined): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(meta ?? {})) out[`metadata[${k}]`] = v;
  return out;
}
