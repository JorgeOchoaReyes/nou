import { randomUUID } from "crypto";

/** A tool-call id that's unique across the whole conversation (for providers that don't supply one). */
export const newCallId = () => `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
