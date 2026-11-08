import { Base } from "./base.js";

export class User extends Base {
  constructor(name) {
    super();
    this.name = name;
  }
  rename(next) {
    this.name = next;
    return this.save();
  }
}

export function createUser(name) {
  return new User(name);
}
