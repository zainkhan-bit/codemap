import x from "./missing";
import y from "not-declared";
import "./styles.css";
import { thing } from "./dup";

export async function load(name: string) {
  const m = await import(name);
  const r = require(name);
  return [x, y, thing, m, r];
}
