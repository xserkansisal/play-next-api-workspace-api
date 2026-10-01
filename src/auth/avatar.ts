// Shared with the web client's palette (src/lib/avatar.ts in play-next-api-workspace-web).
export const AVATAR_COLORS = ["violet", "blue", "green", "orange", "rose", "teal"] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export const DEFAULT_AVATAR_COLOR: AvatarColor = "violet";
