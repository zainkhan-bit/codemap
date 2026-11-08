import { a } from "./a.js";
import _ from "lodash";
import fs from "node:fs";
import "./self.js";
export * from "./b.js";
export { User as Account } from "./models/user.js";

export function main() {
  a();
  return _.identity(fs);
}
