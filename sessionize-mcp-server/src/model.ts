import type { RawEventData, RawQuestionAnswer, RawSession, RawSpeaker } from "./client.js";

export type StatusFilter = "any" | "accepted" | "informed" | "confirmed";

export interface SpeakerRef {
  id: string;
  name: string;
  tagLine: string | null;
  profilePicture: string | null;
}

export interface Session {
  id: string;
  title: string;
  description: string | null;
  status: string | null;
  isInformed: boolean;
  isConfirmed: boolean;
  isServiceSession: boolean;
  isPlenumSession: boolean;
  startsAt: string | null;
  endsAt: string | null;
  room: string | null;
  /** Category title -> selected item names, e.g. { "Track": ["Security"] } */
  categories: Record<string, string[]>;
  /** Question text -> answer */
  questions: Record<string, string>;
  speakers: SpeakerRef[];
  liveUrl: string | null;
  recordingUrl: string | null;
}

export interface Speaker {
  id: string;
  fullName: string;
  firstName: string;
  lastName: string;
  tagLine: string | null;
  bio: string | null;
  profilePicture: string | null;
  isTopSpeaker: boolean;
  links: { title: string; url: string; type: string }[];
  categories: Record<string, string[]>;
  questions: Record<string, string>;
  sessions: { id: string; title: string; status: string | null; isConfirmed: boolean }[];
}

export interface EventModel {
  sessions: Session[];
  speakers: Speaker[];
  rooms: string[];
  categories: { title: string; type: string; items: string[] }[];
}

export function buildModel(raw: RawEventData): EventModel {
  const itemToCategory = new Map<number, { category: string; item: string }>();
  for (const c of raw.categories) for (const i of c.items ?? []) itemToCategory.set(i.id, { category: c.title, item: i.name });
  const questionText = new Map(raw.questions.map((q) => [q.id, q.question]));
  const roomName = new Map(raw.rooms.map((r) => [r.id, r.name]));
  const speakerById = new Map(raw.speakers.map((s) => [s.id, s]));
  const sessionById = new Map(raw.sessions.map((s) => [String(s.id), s]));

  const cats = (ids: number[] | undefined) => {
    const out: Record<string, string[]> = {};
    for (const id of ids ?? []) {
      const hit = itemToCategory.get(id);
      if (hit) (out[hit.category] ??= []).push(hit.item);
    }
    return out;
  };
  const answers = (qa: RawQuestionAnswer[] | undefined) => {
    const out: Record<string, string> = {};
    for (const a of qa ?? []) {
      const q = questionText.get(a.questionId);
      if (q && a.answerValue != null && a.answerValue !== "") out[q] = a.answerValue;
    }
    return out;
  };
  const speakerRef = (id: string): SpeakerRef => {
    const s = speakerById.get(id);
    return {
      id,
      name: s ? s.fullName || `${s.firstName} ${s.lastName}`.trim() : id,
      tagLine: s?.tagLine ?? null,
      profilePicture: s?.profilePicture ?? null,
    };
  };

  const sessions: Session[] = raw.sessions.map((s: RawSession) => ({
    id: String(s.id),
    title: s.title,
    description: s.description ?? null,
    status: s.status ?? null,
    isInformed: Boolean(s.isInformed),
    isConfirmed: Boolean(s.isConfirmed),
    isServiceSession: Boolean(s.isServiceSession),
    isPlenumSession: Boolean(s.isPlenumSession),
    startsAt: s.startsAt ?? null,
    endsAt: s.endsAt ?? null,
    room: s.roomId != null ? (roomName.get(s.roomId) ?? null) : null,
    categories: cats(s.categoryItems),
    questions: answers(s.questionAnswers),
    speakers: (s.speakers ?? []).map(speakerRef),
    liveUrl: s.liveUrl ?? null,
    recordingUrl: s.recordingUrl ?? null,
  }));

  const speakers: Speaker[] = raw.speakers.map((s: RawSpeaker) => ({
    id: s.id,
    fullName: s.fullName || `${s.firstName} ${s.lastName}`.trim(),
    firstName: s.firstName,
    lastName: s.lastName,
    tagLine: s.tagLine ?? null,
    bio: s.bio ?? null,
    profilePicture: s.profilePicture ?? null,
    isTopSpeaker: Boolean(s.isTopSpeaker),
    links: (s.links ?? []).map((l) => ({ title: l.title, url: l.url, type: l.linkType })),
    categories: cats(s.categoryItems),
    questions: answers(s.questionAnswers),
    sessions: (s.sessions ?? []).map((id) => {
      const sess = sessionById.get(String(id));
      return { id: String(id), title: sess?.title ?? "", status: sess?.status ?? null, isConfirmed: Boolean(sess?.isConfirmed) };
    }),
  }));

  return {
    sessions,
    speakers,
    rooms: raw.rooms.map((r) => r.name),
    categories: raw.categories.map((c) => ({ title: c.title, type: c.type, items: (c.items ?? []).map((i) => i.name) })),
  };
}

export function matchesStatus(s: Pick<Session, "status" | "isInformed" | "isConfirmed">, f: StatusFilter): boolean {
  switch (f) {
    case "any":
      return true;
    case "accepted":
      return (s.status ?? "").toLowerCase() === "accepted";
    case "informed":
      return (s.status ?? "").toLowerCase() === "accepted" && s.isInformed;
    case "confirmed":
      return (s.status ?? "").toLowerCase() === "accepted" && s.isConfirmed;
  }
}

export interface SessionFilter {
  status?: StatusFilter;
  category?: string;
  room?: string;
  search?: string;
  includeServiceSessions?: boolean;
}

const norm = (v: string) => v.toLowerCase();

export function filterSessions(sessions: Session[], f: SessionFilter): Session[] {
  const status = f.status ?? "any";
  return sessions.filter((s) => {
    if (!f.includeServiceSessions && s.isServiceSession) return false;
    if (!matchesStatus(s, status)) return false;
    if (f.room && norm(s.room ?? "") !== norm(f.room)) return false;
    if (f.category) {
      const want = norm(f.category);
      const hit = Object.entries(s.categories).some(([cat, items]) => norm(cat) === want || items.some((i) => norm(i) === want));
      if (!hit) return false;
    }
    if (f.search) {
      const q = norm(f.search);
      const hay = [s.title, s.description ?? "", ...s.speakers.map((p) => p.name)].join(" ");
      if (!norm(hay).includes(q)) return false;
    }
    return true;
  });
}

/** Speakers who have at least one session matching the filter (or all speakers when status is "any" and no filter). */
export function filterSpeakers(model: EventModel, f: SessionFilter): Speaker[] {
  const sessionScoped = (f.status && f.status !== "any") || f.category || f.room;
  if (sessionScoped) {
    // Only speakers with a session that passes every filter (search included).
    const visible = new Set(filterSessions(model.sessions, f).flatMap((s) => s.speakers.map((p) => p.id)));
    return model.speakers.filter((sp) => visible.has(sp.id));
  }
  if (!f.search) return model.speakers;
  const q = norm(f.search);
  const viaSessions = new Set(filterSessions(model.sessions, f).flatMap((s) => s.speakers.map((p) => p.id)));
  return model.speakers.filter((sp) => viaSessions.has(sp.id) || norm(sp.fullName).includes(q));
}
