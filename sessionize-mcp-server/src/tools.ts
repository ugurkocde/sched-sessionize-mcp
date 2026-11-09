import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SessionizeClient } from "./client.js";
import {
  downloadSpeakerPhotos,
  resolveOutputDir,
  sessionsToCsv,
  sessionsToMarkdown,
  speakersToCsv,
  speakersToMarkdown,
  type ExportFormat,
} from "./export.js";
import { buildModel, filterSessions, filterSpeakers, matchesStatus, type SessionFilter, type StatusFilter } from "./model.js";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** True when the tool only reads Sessionize data and writes nothing locally. */
  readOnly: boolean;
  inputSchema: z.ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (client: SessionizeClient, args: any) => Promise<unknown>;
}

const status = z
  .enum(["any", "accepted", "informed", "confirmed"])
  .default("any")
  .describe(
    "any: everything the endpoint exposes. accepted: status Accepted. informed: accepted and the speaker was told. confirmed: accepted and the speaker confirmed attendance. The endpoint's own 'Includes sessions' setting limits what is visible at all.",
  );
const filters = {
  status,
  category: z.string().optional().describe("Category title or item name, e.g. a track name. Case-insensitive exact match."),
  room: z.string().optional().describe("Room name, case-insensitive exact match."),
  search: z.string().optional().describe("Case-insensitive text search in title, description and speaker names."),
  include_service_sessions: z.boolean().default(false).describe("Include service sessions such as breaks and lunch."),
  refresh: z.boolean().default(false).describe("Bypass this server's short cache and refetch from Sessionize."),
};
const paging = {
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
};

const toFilter = (a: Record<string, unknown>): SessionFilter => ({
  status: a.status as StatusFilter,
  category: a.category as string | undefined,
  room: a.room as string | undefined,
  search: a.search as string | undefined,
  includeServiceSessions: a.include_service_sessions as boolean,
});

const page = <T>(items: T[], limit: number, offset: number) => ({
  total: items.length,
  offset,
  returned: Math.min(limit, Math.max(0, items.length - offset)),
  items: items.slice(offset, offset + limit),
});

export const TOOLS: ToolDef[] = [
  {
    name: "sessionize_get_overview",
    title: "Event overview",
    readOnly: true,
    description:
      "Counts of sessions by status (accepted, informed, confirmed), speakers, rooms and the available categories (tracks, formats, levels). Good first call.",
    inputSchema: { refresh: filters.refresh },
    run: async (c, a) => {
      const m = buildModel(await c.getAll(a.refresh));
      const regular = m.sessions.filter((s) => !s.isServiceSession);
      const count = (f: StatusFilter) => regular.filter((s) => matchesStatus(s, f)).length;
      return {
        sessions: {
          total: regular.length,
          accepted: count("accepted"),
          informed: count("informed"),
          confirmed: count("confirmed"),
          serviceSessions: m.sessions.length - regular.length,
          scheduled: regular.filter((s) => s.startsAt).length,
        },
        speakers: m.speakers.length,
        speakersWithPhoto: m.speakers.filter((s) => s.profilePicture).length,
        rooms: m.rooms,
        categories: m.categories,
        note:
          "Only sessions allowed by the endpoint's 'Includes sessions' setting are visible. Times and rooms appear only after the schedule is announced in Sessionize.",
      };
    },
  },
  {
    name: "sessionize_list_sessions",
    title: "List sessions",
    readOnly: true,
    description:
      "List sessions with title, description, status, categories, room, times and speakers (name, tagline, profile picture URL). Filter by status (e.g. confirmed), category/track, room or text.",
    inputSchema: {
      ...filters,
      include_description: z.boolean().default(true),
      ...paging,
    },
    run: async (c, a) => {
      const m = buildModel(await c.getAll(a.refresh));
      const items = filterSessions(m.sessions, toFilter(a)).map((s) => (a.include_description ? s : { ...s, description: undefined }));
      return page(items, a.limit, a.offset);
    },
  },
  {
    name: "sessionize_get_session",
    title: "Get session",
    readOnly: true,
    description: "One session by ID, with full description, answers to session questions and speaker details.",
    inputSchema: { id: z.string().min(1), refresh: filters.refresh },
    run: async (c, a) => {
      const m = buildModel(await c.getAll(a.refresh));
      const s = m.sessions.find((x) => x.id === String(a.id));
      if (!s) throw new Error(`No session with id ${a.id} is visible on this endpoint`);
      const speakers = m.speakers.filter((sp) => s.speakers.some((p) => p.id === sp.id));
      return { ...s, speakerDetails: speakers };
    },
  },
  {
    name: "sessionize_list_speakers",
    title: "List speakers",
    readOnly: true,
    description:
      "List speakers with name, tagline, bio, profile picture URL, links and their sessions. Status/category/room filters keep only speakers who have a matching session.",
    inputSchema: {
      ...filters,
      include_bio: z.boolean().default(true),
      ...paging,
    },
    run: async (c, a) => {
      const m = buildModel(await c.getAll(a.refresh));
      const items = filterSpeakers(m, toFilter(a)).map((s) => (a.include_bio ? s : { ...s, bio: undefined }));
      return page(items, a.limit, a.offset);
    },
  },
  {
    name: "sessionize_get_speaker",
    title: "Get speaker",
    readOnly: true,
    description: "One speaker by ID, with bio, profile picture URL, links, answers to speaker questions and sessions.",
    inputSchema: { id: z.string().min(1), refresh: filters.refresh },
    run: async (c, a) => {
      const m = buildModel(await c.getAll(a.refresh));
      const s = m.speakers.find((x) => x.id === String(a.id));
      if (!s) throw new Error(`No speaker with id ${a.id} is visible on this endpoint`);
      return s;
    },
  },
  {
    name: "sessionize_export",
    title: "Export to files",
    readOnly: false,
    description:
      "Write sessions or speakers to a local file (JSON, CSV or Markdown) in an absolute output_dir, optionally downloading speaker profile pictures into output_dir/photos. Never changes Sessionize data.",
    inputSchema: {
      what: z.enum(["sessions", "speakers"]),
      format: z.enum(["json", "csv", "markdown"]).default("csv"),
      output_dir: z.string().min(1).describe("Absolute directory path. Created if missing."),
      download_photos: z.boolean().default(false).describe("Also save each included speaker's profile picture."),
      ...filters,
    },
    run: async (c, a) => {
      const dir = resolveOutputDir(a.output_dir);
      const m = buildModel(await c.getAll(a.refresh));
      const f = toFilter(a);
      const sessions = filterSessions(m.sessions, f);
      const speakers = filterSpeakers(m, f);
      const format = a.format as ExportFormat;
      const ext = format === "markdown" ? "md" : format;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = join(dir, `sessionize-${a.what}-${a.status}-${stamp}.${ext}`);

      let body: string;
      if (a.what === "sessions") {
        body = format === "csv" ? sessionsToCsv(sessions) : format === "markdown" ? sessionsToMarkdown(sessions) : JSON.stringify(sessions, null, 2);
      } else {
        body = format === "csv" ? speakersToCsv(speakers) : format === "markdown" ? speakersToMarkdown(speakers) : JSON.stringify(speakers, null, 2);
      }
      await mkdir(dir, { recursive: true });
      await writeFile(file, body, "utf8");

      let photos;
      if (a.download_photos) {
        const needed = a.what === "sessions" ? speakers.filter((sp) => sessions.some((s) => s.speakers.some((p) => p.id === sp.id))) : speakers;
        photos = await downloadSpeakerPhotos(c, needed, join(dir, "photos"));
      }
      return {
        file,
        rows: a.what === "sessions" ? sessions.length : speakers.length,
        photos: photos && {
          saved: photos.filter((p) => p.file).length,
          failed: photos.filter((p) => p.error).map((p) => `${p.name}: ${p.error}`),
          dir: join(dir, "photos"),
        },
      };
    },
  },
];
