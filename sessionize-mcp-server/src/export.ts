import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionizeClient } from "./client.js";
import type { Session, Speaker } from "./model.js";

export type ExportFormat = "json" | "csv" | "markdown";

/** UTF-8 byte order mark so Excel opens the CSV as UTF-8 (umlauts, accents). */
const BOM = "\uFEFF";

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};
const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");
const flatCats = (c: Record<string, string[]>) =>
  Object.entries(c)
    .map(([k, v]) => `${k}: ${v.join(", ")}`)
    .join("; ");

export function sessionsToCsv(sessions: Session[]): string {
  const header = [
    "id", "title", "description", "status", "is_informed", "is_confirmed", "starts_at", "ends_at", "room",
    "categories", "speakers", "speaker_ids", "speaker_photos",
  ];
  const rows = sessions.map((s) =>
    csvRow([
      s.id, s.title, s.description, s.status, s.isInformed, s.isConfirmed, s.startsAt, s.endsAt, s.room,
      flatCats(s.categories),
      s.speakers.map((p) => p.name).join("; "),
      s.speakers.map((p) => p.id).join("; "),
      s.speakers.map((p) => p.profilePicture ?? "").join("; "),
    ]),
  );
  return BOM + [csvRow(header), ...rows].join("\r\n") + "\r\n";
}

export function speakersToCsv(speakers: Speaker[]): string {
  const header = ["id", "full_name", "first_name", "last_name", "tag_line", "bio", "profile_picture", "links", "sessions"];
  const rows = speakers.map((s) =>
    csvRow([
      s.id, s.fullName, s.firstName, s.lastName, s.tagLine, s.bio, s.profilePicture,
      s.links.map((l) => `${l.title}: ${l.url}`).join("; "),
      s.sessions.map((x) => x.title).join("; "),
    ]),
  );
  return BOM + [csvRow(header), ...rows].join("\r\n") + "\r\n";
}

export function sessionsToMarkdown(sessions: Session[]): string {
  return sessions
    .map((s) => {
      const lines = [`## ${s.title}`, ""];
      const meta = [
        s.status ? `Status: ${s.status}${s.isConfirmed ? " (confirmed)" : s.isInformed ? " (informed)" : ""}` : null,
        s.room ? `Room: ${s.room}` : null,
        s.startsAt ? `Time: ${s.startsAt}${s.endsAt ? ` to ${s.endsAt}` : ""}` : null,
        Object.keys(s.categories).length ? flatCats(s.categories) : null,
      ].filter(Boolean);
      if (meta.length) lines.push(meta.join(" | "), "");
      if (s.speakers.length) {
        lines.push(`Speakers: ${s.speakers.map((p) => (p.tagLine ? `${p.name} (${p.tagLine})` : p.name)).join(", ")}`, "");
        for (const p of s.speakers) if (p.profilePicture) lines.push(`![${p.name}](${p.profilePicture})`);
        lines.push("");
      }
      if (s.description) lines.push(s.description, "");
      return lines.join("\n");
    })
    .join("\n");
}

export function speakersToMarkdown(speakers: Speaker[]): string {
  return speakers
    .map((s) => {
      const lines = [`## ${s.fullName}`, ""];
      if (s.tagLine) lines.push(`*${s.tagLine}*`, "");
      if (s.profilePicture) lines.push(`![${s.fullName}](${s.profilePicture})`, "");
      if (s.bio) lines.push(s.bio, "");
      if (s.sessions.length) lines.push(`Sessions: ${s.sessions.map((x) => x.title).join("; ")}`, "");
      if (s.links.length) lines.push(s.links.map((l) => `[${l.title}](${l.url})`).join(" | "), "");
      return lines.join("\n");
    })
    .join("\n");
}

export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "speaker";
}

function extFor(url: string, contentType: string): string {
  if (/png/i.test(contentType)) return "png";
  if (/webp/i.test(contentType)) return "webp";
  if (/gif/i.test(contentType)) return "gif";
  if (/jpe?g/i.test(contentType)) return "jpg";
  const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif)$/i);
  return m ? m[1]!.toLowerCase().replace("jpeg", "jpg") : "jpg";
}

export function resolveOutputDir(dir: string): string {
  if (!isAbsolute(dir)) throw new Error(`output_dir must be an absolute path, got: ${dir}`);
  return resolve(dir);
}

export interface ImageResult {
  speakerId: string;
  name: string;
  file?: string;
  error?: string;
}

/** Downloads each speaker's profile picture into `dir` as <name-slug>-<id8>.<ext>. */
export async function downloadSpeakerPhotos(
  client: SessionizeClient,
  speakers: { id: string; fullName: string; profilePicture: string | null }[],
  dir: string,
): Promise<ImageResult[]> {
  await mkdir(dir, { recursive: true });
  const results: ImageResult[] = [];
  for (const sp of speakers) {
    if (!sp.profilePicture) {
      results.push({ speakerId: sp.id, name: sp.fullName, error: "no profile picture" });
      continue;
    }
    try {
      const { bytes, contentType } = await client.downloadImage(sp.profilePicture);
      const file = join(dir, `${slugify(sp.fullName)}-${sp.id.replace(/[^A-Za-z0-9]/g, "").slice(-8)}.${extFor(sp.profilePicture, contentType)}`);
      await writeFile(file, bytes);
      results.push({ speakerId: sp.id, name: sp.fullName, file });
    } catch (err) {
      results.push({ speakerId: sp.id, name: sp.fullName, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
