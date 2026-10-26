/** Stands in for string-width (see fast-width.ts): the real one, named in this module's URL, made faster. */
import { fastStringWidth } from "./fast-width.js";

const of = new URL(import.meta.url).searchParams.get("of");
if (!of) throw new Error("width-shim needs ?of=<string-width url>");
const real = (await import(of)).default;

export default fastStringWidth(real);
